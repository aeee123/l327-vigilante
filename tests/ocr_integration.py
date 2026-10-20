"""Real Tesseract + production classifier, using synthetic images, no Telegram calls."""
import importlib.util
import json
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('reader', ROOT / 'tools' / 'ocr_reader.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
now = datetime.now(timezone.utc)
local = now - timedelta(hours=6)
tomorrow = (local + timedelta(days=1)).strftime('%d/%m/%Y')
past = (local - timedelta(days=10)).strftime('%d/%m/%Y')
cases = [
    ('circuito_correcto', 'SIS-L327', tomorrow, True),
    ('otro_circuito', 'L-328', tomorrow, False),
    ('fecha_vencida', 'L-327', past, False),
    ('solo_ciudad', 'La Ceiba', tomorrow, False),
]
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 54)
with tempfile.TemporaryDirectory(prefix='l327-test-') as temp:
    for name, circuit, date, expected in cases:
        im = Image.new('RGB', (1800, 600), 'white')
        draw = ImageDraw.Draw(im)
        for i, line in enumerate(['PRUEBA DEL SISTEMA', 'Mantenimiento programado', f'Circuito: {circuit}', f'Fecha: {date}']):
            draw.text((50, 50 + i * 115), line, font=font, fill='black')
        path = Path(temp) / (name + '.png')
        im.save(path)
        unit = reader.recognize(path)
        assert unit['confidence'] >= 55, (name, 'confianza OCR insuficiente')
        candidate = {'text': unit['text'], 'published': now.isoformat()}
        code = "import {classify} from './worker/core.js';let input='';for await(const chunk of process.stdin) input+=chunk;console.log(JSON.stringify(classify(JSON.parse(input))));"
        result = subprocess.run(['node', '--input-type=module', '-e', code], cwd=ROOT, input=json.dumps(candidate), text=True, capture_output=True, check=True)
        decision = json.loads(result.stdout)
        assert decision['relevant'] is expected, (name, unit, decision)
        print(json.dumps({'test': name, 'ocr_confidence': unit['confidence'], 'accepted': decision['relevant'], 'passed': True}))
print('OCR real + filtro: 4 casos correctos. No se enviaron alertas ficticias.')
