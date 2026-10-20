import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ocr_reader', Path(__file__).parents[1] / 'tools' / 'ocr_reader.py')
ocr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocr)


class ReaderTests(unittest.TestCase):
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
