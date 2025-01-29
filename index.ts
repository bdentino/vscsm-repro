import * as http from 'node:http';

export type DummyTypeThatWillGetCompiledAway = {
  a: string;
  b: number;
  c: boolean;
  d: {
    e: string;
    f: number;
  },
  g: string[];
  h: number[];
  i: boolean[];
  j: {
    k: string[];
    l: number[];
    m: boolean[];
  }
}

const server = http.createServer((req, res) => {
  debugger;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('OK');
});

const port = 3000;
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}/`);
});
