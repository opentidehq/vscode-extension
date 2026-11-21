// Local fake Elastic (Kibana :5601 + Elasticsearch :9200). Logs every request. Never contacts anything else.
const http = require('http'); const fs = require('fs');
const log = (s) => fs.appendFileSync('/tmp/qa/fake-tenant.log', s + '\n');
for (const port of [5601, 9200]) {
  http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      log(JSON.stringify({ t: new Date().toISOString(), port, method: req.method, url: req.url, auth: req.headers.authorization === 'ApiKey fake-key-qa' ? 'matches-env-file-value' : (req.headers.authorization ? 'present-other' : '(none)'), ct: req.headers['content-type'], body: b.slice(0, 600) }));
      res.setHeader('content-type', 'application/json'); res.setHeader('x-elastic-product', 'Elasticsearch');
      if (req.url.startsWith('/api/status')) return res.end(JSON.stringify({ name: 'fake', version: { number: '9.0.0' }, status: { overall: { level: 'available' } } }));
      if (req.url === '/' ) return res.end(JSON.stringify({ name: 'fake', cluster_name: 'fake', version: { number: '9.0.0', build_flavor: 'default' }, tagline: 'You Know, for Search' }));
      if (req.url.includes('_query') || req.url.includes('_search')) return res.end(JSON.stringify({ took: 1, columns: [{ name: 'event.code', type: 'keyword' }], values: [] , hits: { total: { value: 0 }, hits: [] }}));
      res.end(JSON.stringify({}));
    });
  }).listen(port, '127.0.0.1', () => log('listening ' + port));
}
