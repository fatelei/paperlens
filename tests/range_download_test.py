import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('range_download', Path(__file__).resolve().parents[1] / 'local_jev/range_download.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class RangeDownloadTests(unittest.TestCase):
    def run_server(self, mode):
        data = bytes(range(256)) * 4096
        ranges = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                start, end = map(int, self.headers['Range'][6:].split('-'))
                ranges.append((start,end))
                if mode == 'ignore':
                    self.send_response(200); self.end_headers(); return
                self.send_response(206)
                actual = start + 1 if mode == 'wrong' and end > 0 else start
                self.send_header('Content-Range', f'bytes {actual}-{end}/{len(data)}')
                self.send_header('Content-Length', str(end-start+1)); self.end_headers()
                if mode == 'mid-fail' and start == 65536:
                    return
                self.wfile.write(data[start:end+1])
        server=ThreadingHTTPServer(('127.0.0.1',0), Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        return f'http://127.0.0.1:{server.server_port}/file',data,ranges

    def test_parallel_resume_keeps_existing_prefix(self):
        url,data,ranges=self.run_server('valid')
        with tempfile.TemporaryDirectory() as tmp:
            part=Path(tmp)/'model.part';offset=12345;part.write_bytes(data[:offset])
            updates=[]
            self.assertTrue(module.download_ranges(url,part,lambda *x:updates.append(x),65536))
            self.assertEqual(part.read_bytes(),data)
            self.assertTrue(all(start>=offset for start,end in ranges if end>0))
            self.assertEqual(updates[-1][1],1)

    def test_unsupported_ranges_do_not_touch_prefix(self):
        url,data,_=self.run_server('ignore')
        with tempfile.TemporaryDirectory() as tmp:
            part=Path(tmp)/'model.part';part.write_bytes(data[:42])
            self.assertFalse(module.download_ranges(url,part,lambda *x:None,65536))
            self.assertEqual(part.read_bytes(),data[:42])

    def test_wrong_range_preserves_prefix(self):
        url,data,_=self.run_server('wrong')
        with tempfile.TemporaryDirectory() as tmp:
            part=Path(tmp)/'model.part';part.write_bytes(data[:42])
            with self.assertRaises(RuntimeError):module.download_ranges(url,part,lambda *x:None,65536)
            self.assertEqual(part.read_bytes(),data[:42])

    def test_failed_middle_chunk_retains_contiguous_prefix_and_resumes(self):
        url,data,_=self.run_server('mid-fail')
        with tempfile.TemporaryDirectory() as tmp:
            part=Path(tmp)/'model.part'
            with self.assertRaises(OSError):module.download_ranges(url,part,lambda *x:None,65536)
            self.assertEqual(part.read_bytes(),data[:65536])
            retry_url,_,_=self.run_server('valid')
            self.assertTrue(module.download_ranges(retry_url,part,lambda *x:None,65536))
            self.assertEqual(part.read_bytes(),data)

if __name__=='__main__':unittest.main()
