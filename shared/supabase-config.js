const SUPABASE_URL      = 'https://otzyszbbsuwoxupbpfju.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90enlzemJic3V3b3h1cGJwZmp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NDU5ODMsImV4cCI6MjA5MDMyMTk4M30.s8XzcbpZ2PCwOvXJcN7LqPKhqyZop_hdUOFdvLbPCWU';
const IPFS_GATEWAY      = 'https://ipfs.blacklusion.cloud/ipfs/';

// Single source of truth for IPFS gateway fallback order — public gateways don't
// all have the same peers/cache, so pages cycle through these on image load error
// instead of retrying the same one. Was hand-copied into every page; edit here only.
// IPFS_GATEWAY_LIST[0] must stay equal to IPFS_GATEWAY — several pages' onerror
// handlers start their retry loop at index 1, assuming index 0 is the gateway the
// initial (non-fallback) image load already tried and failed.
// Order is based on live testing (2026-08-19): blacklusion.cloud and eosdac.io are
// WAX block-producer-run gateways that recovered CIDs the general-purpose public
// gateways (ipfs.io, Pinata, dweb.link) couldn't, and were consistently faster.
// Pinata sits ahead of eosdac (both #2 candidates) because it's a genuinely
// different pinning source — two BP gateways likely overlap in what they hold,
// so trying Pinata 2nd has better odds of recovering a CID blacklusion missed
// than trying another BP would.
const IPFS_GATEWAY_LIST = [
  IPFS_GATEWAY,
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.eosdac.io/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
];
