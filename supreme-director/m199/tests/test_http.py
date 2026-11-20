"""Local HTTP integration, auth, headers and no public bind."""
import json
from http.server import ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from osgard_m192.runtime import Invalid
from osgard_m199.runtime import Director199
from osgard_m199.server import handler_for, serve


class PortfolioHTTPTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        app = Director199(Path(tmp.name) / 'test.sqlite')
        app.initialize()
        self.owner = app.provision('Agency', 'owner')['token']
        self.viewer = app.issue_token(self.owner, 'reader', 'viewer')['token']
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(app))
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)

    def operation(self, name, token=None, origin=None):
        request = Request(self.url + '/v1/execute', method='POST', data=json.dumps({
            'operation': name, 'payload': {}, 'idempotency_key': None
        }).encode(), headers={
            'Authorization': 'Bearer ' + (token or self.owner),
            'Content-Type': 'application/json',
            'Origin': origin or self.url,
        })
        with urlopen(request, timeout=5) as response:
            return json.loads(response.read())

    def test_html_and_styles_served(self):
        with urlopen(self.url + '/portfolio/', timeout=5) as response:
            self.assertIn('Сводная аналитика', response.read().decode())
            self.assertEqual(response.headers.get('X-Content-Type-Options'), 'nosniff')
            self.assertIn("default-src 'none'", response.headers.get('Content-Security-Policy'))
        for path, content in [('/portfolio/app.js', b'commerce.portfolio.overview'),
                              ('/portfolio/styles.css', b'.hero')]:
            with urlopen(self.url + path, timeout=5) as response:
                self.assertIn(content, response.read())

    def test_api_overview_live(self):
        result = self.operation('commerce.portfolio.overview')['result']
        self.assertEqual(result['totals']['project_count'], 0)
        self.assertFalse(result['production_authorized'])

    def test_api_calendar_live(self):
        result = self.operation('commerce.portfolio.calendar')['result']
        self.assertEqual(len(result['buckets']), 6)

    def test_api_viewer_forbidden(self):
        with self.assertRaises(HTTPError) as exc:
            self.operation('commerce.portfolio.overview', self.viewer)
        self.assertEqual(exc.exception.code, 403)

    def test_cross_site_denied(self):
        with self.assertRaises(HTTPError) as exc:
            self.operation('commerce.portfolio.overview', origin='http://evil.invalid')
        self.assertEqual(exc.exception.code, 403)

    def test_host_denied(self):
        request = Request(self.url + '/portfolio/', headers={'Host': 'remote.invalid'})
        with self.assertRaises(HTTPError) as exc:
            urlopen(request, timeout=5)
        self.assertEqual(exc.exception.code, 403)

    def test_public_bind_denied(self):
        with self.assertRaises(Invalid):
            serve(None, bind='0.0.0.0')


if __name__ == '__main__':
    unittest.main()
