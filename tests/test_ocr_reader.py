import importlib.util
import io
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ocr_reader', Path(__file__).parents[1] / 'tools' / 'ocr_reader.py')
ocr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocr)


class ReaderTests(unittest.TestCase):
    @patch.dict(ocr.os.environ, {'BOT_URL':'https://bot.example','ADMIN_TOKEN':'fake-token','GITHUB_STEP_SUMMARY':''})
    @patch.object(ocr.time, 'sleep')
    @patch.object(ocr, 'extract', return_value=[{'text':'ilegible','confidence':10}])
    @patch.object(ocr, 'download', return_value=(b'image','image'))
    @patch.object(ocr, 'api')
    def test_low_confidence_remains_review_without_failing_execution(self, api, download, extract, sleep):
        api.side_effect = [{'items':[{'id':'test','url':'https://pbs.twimg.com/a.jpg'}]}, {'accepted':False,'needs_review':True,'reason':'OCR vacío'}]
        with patch('sys.stdout', new=io.StringIO()) as output:
            ocr.main()
        self.assertIn('Requieren revisión: 1', output.getvalue())
        self.assertIn('Fallos de ejecución: 0', output.getvalue())

    @patch.dict(ocr.os.environ, {'BOT_URL':'https://bot.example','ADMIN_TOKEN':'fake-token','GITHUB_STEP_SUMMARY':''})
    @patch.object(ocr.time, 'sleep')
    @patch.object(ocr, 'download', side_effect=ocr.urllib.error.URLError('network'))
    @patch.object(ocr, 'api')
    def test_transport_failure_still_fails_execution(self, api, download, sleep):
        api.side_effect = [{'items':[{'id':'test','url':'https://pbs.twimg.com/a.jpg'}]}, {'accepted':False}]
        with patch('sys.stdout', new=io.StringIO()), self.assertRaises(SystemExit):
            ocr.main()
    @patch.object(ocr.time, 'sleep')
    @patch.object(ocr.urllib.request, 'build_opener')
    def test_api_retries_when_collection_is_busy(self, opener, sleep):
        response = opener.return_value.open.return_value
        response.__enter__.return_value.read.return_value = b'{"accepted": true}'
        opener.return_value.open.side_effect = [ocr.urllib.error.HTTPError('https://bot.example/ingest',409,'busy',{},None),response]
        self.assertTrue(ocr.api('https://bot.example','fake-token','/ingest',{'id':'test'})['accepted'])
        self.assertEqual(opener.return_value.open.call_count,2)
        sleep.assert_called_once()
    @patch.object(ocr.urllib.request, 'build_opener')
    def test_api_identifies_reader_to_cloudflare(self, opener):
        opener.return_value.open.return_value.__enter__.return_value.read.return_value = b'{"items": []}'
        self.assertEqual(ocr.api('https://bot.example', 'fake-token', '/media'), {'items': []})
        request = opener.return_value.open.call_args.args[0]
        self.assertEqual(request.get_header('User-agent'), 'L327-Vigilante-OCR/2.0')
    def test_only_allowed_public_hosts(self):
        for url in ['http://pbs.twimg.com/a.jpg', 'https://127.0.0.1/a', 'https://pbs.twimg.com.evil.example/a', 'https://user:pass@pbs.twimg.com/a']:
            with self.assertRaises(ValueError):
                ocr.public_url(url)

    @patch.object(ocr.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 443))])
    def test_rejects_private_dns_address(self, _):
        with self.assertRaises(ValueError):
            ocr.public_url('https://pbs.twimg.com/a.jpg')

    @patch.object(ocr.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('8.8.8.8', 443))])
    def test_accepts_allowed_public_address(self, _):
        self.assertEqual(ocr.public_url('https://pbs.twimg.com/a.jpg'), 'https://pbs.twimg.com/a.jpg')

    @patch.object(ocr.subprocess, 'run')
    def test_groups_tsv_into_lines_and_measures_confidence(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, stdout='page_num\tblock_num\tpar_num\tline_num\tconf\ttext\n1\t1\t1\t1\t90\tL-327\n1\t1\t1\t1\t80\tsin\n1\t1\t1\t2\t70\tluz\n')
        result = ocr.recognize(Path('fake.png'))
        self.assertEqual(result['text'], 'L-327 sin\nluz')
        self.assertEqual(result['confidence'], 80)

    @patch.object(ocr.subprocess, 'run')
    def test_empty_ocr_is_not_success(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, stdout='page_num\tblock_num\tpar_num\tline_num\tconf\ttext\n')
        self.assertEqual(ocr.recognize(Path('fake.png'))['confidence'], 0)

    def test_unbounded_document_link_recursion_is_rejected(self):
        with self.assertRaises(ValueError):
            ocr.download('https://pbs.twimg.com/a.jpg', depth=4)


if __name__ == '__main__':
    unittest.main()
