import { getStore } from '@netlify/blobs';
import { createMcpHandler } from '../../lib/mcp.js';
import { BlobStore } from '../../lib/store/index.js';

let handler;

export default async (req) => {
  handler ??= createMcpHandler(new BlobStore(getStore({ name: 'termwise', consistency: 'strong' })));
  return handler(req);
};

export const config = { path: '/mcp' };
