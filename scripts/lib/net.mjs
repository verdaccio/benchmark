import { createServer } from 'node:net';

// Ask the OS for a currently-free TCP port on loopback. Avoids collisions with
// leaked processes from a previous run that fixed port numbers would hit.
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
