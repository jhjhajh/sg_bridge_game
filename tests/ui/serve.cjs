// Serve the actual frontend without starting Workers or touching a real game.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const assets = {
  '/view.js': ['view.js', 'text/javascript'],
  '/view.css': ['view.css', 'text/css'],
  '/bridge/': ['bridge/index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript'],
  '/hand.js': ['hand.js', 'text/javascript'],
};

exports.createServer = () => http.createServer(async (request, response) => {
  const asset = assets[new URL(request.url, 'http://localhost').pathname];
  if (!asset) {
    response.writeHead(404).end();
    return;
  }
  try {
    const content = await fs.readFile(path.join(__dirname, '../../static', asset[0]));
    response.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` });
    response.end(content);
  } catch {
    response.writeHead(500).end();
  }
});
