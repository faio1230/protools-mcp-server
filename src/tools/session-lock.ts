import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { setTimeout } from 'node:timers/promises';

const pending = new Map<number, Promise<void>>();

function lockPort(endpoint: string): number {
  // PTSL has one session per host process. Key on its port so local aliases
  // such as localhost, 127.0.0.1, and ::1 cannot acquire separate locks.
  const endpointPort = endpoint.match(/:(\d+)$/)?.[1] ?? '31416';
  const digest = createHash('sha256').update(`protools-mcp:${Number(endpointPort)}`).digest();
  const port = 20000 + digest.readUInt16BE() % 12000;
  return port === Number(endpointPort) ? port + 12000 : port;
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(socket => socket.destroy());
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(server));
  });
}

async function acquire(port: number, endpoint: string): Promise<Server> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      return await listen(port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      if (Date.now() >= deadline) {
        throw new Error(`PTSL endpoint ${endpoint} is busy or its local coordination port ${port} is in use. Retry after the active operation completes.`);
      }
      await setTimeout(100);
    }
  }
}

export async function withSessionLock<T>(endpoint: string, operation: () => Promise<T>): Promise<T> {
  const port = lockPort(endpoint);
  const previous = pending.get(port);
  let advance!: () => void;
  const current = new Promise<void>(resolve => { advance = resolve; });
  pending.set(port, current);
  try {
    await previous;
    // A loopback-only listener gives local stdio and HTTP workers an atomic
    // lock that the OS releases on process exit, including uncatchable exits.
    const lock = await acquire(port, endpoint);
    try {
      return await operation();
    } finally {
      await new Promise<void>(resolve => { lock.close(() => resolve()); });
    }
  } finally {
    advance();
    if (pending.get(port) === current) pending.delete(port);
  }
}
