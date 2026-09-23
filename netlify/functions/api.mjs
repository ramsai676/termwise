import { getStore } from '@netlify/blobs';
import { createHandler } from '../../lib/api.js';
import { BlobStore } from '../../lib/store/index.js';

let handler;

export default async (req) => {
  handler ??= createHandler(new BlobStore(getStore({ name: 'termwise', consistency: 'strong' })));
  return handler(req);
};

export const config = { path: '/api/*' };
