'use strict';

// TEMPORARY REVIEW MODE ONLY.
// This file intentionally disables the coach credential comparison so the
// owner can inspect the product before normal authentication is finalized.
// Remove this preload and restore the normal start command after review.
const security = require('./lib/coaching/security');
security.secureEquals = () => true;
process.env.COACH_PORTAL_ADMIN_TOKEN = 'preview-mode-enabled';
