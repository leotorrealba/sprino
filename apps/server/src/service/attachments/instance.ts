// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Module-level StorageBackend singleton shared by HTTP and MCP adapters.
 *
 * Reads ATTACHMENT_STORAGE_DIR from env at module load time. Default is
 * './data/attachments' relative to the server's working directory.
 *
 * For cloud deployments swap LocalStorageBackend for S3StorageBackend here;
 * the rest of the codebase stays unchanged because adapters import from this
 * file rather than constructing the backend themselves.
 *
 * Tests that call service functions directly inject their own temp-dir
 * LocalStorageBackend instance — this singleton is only used by adapters.
 */
import { LocalStorageBackend } from './local-storage.ts';

const storageDir =
  process.env.ATTACHMENT_STORAGE_DIR ?? './data/attachments';

export const storage = new LocalStorageBackend(storageDir);
