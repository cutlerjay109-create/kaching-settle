// program/src/constants.rs
// Seeds and fixed values used across all instructions.
// Must match shared/constants.js exactly.

pub const SEED_MARKET: &[u8] = b"market";
pub const SEED_YES_VAULT: &[u8] = b"yes_vault";
pub const SEED_NO_VAULT: &[u8] = b"no_vault";
pub const SEED_POSITION: &[u8] = b"position";

pub const MIN_STAKE: u64 = 1_000_000; // $1 in USDC (6 decimals)
pub const MAX_STAKE: u64 = 10_000_000_000; // $10,000

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_LOCKED: u8 = 1;
pub const STATUS_SETTLED: u8 = 2;
pub const STATUS_VOID: u8 = 3;

pub const SIDE_YES: u8 = 0;
pub const SIDE_NO: u8 = 1;
