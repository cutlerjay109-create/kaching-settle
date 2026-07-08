// program/src/state/market.rs
// The market account stored on-chain.
// One per fixture — holds totals, status, and settlement result.

use anchor_lang::prelude::*;

#[account]
pub struct Market {
    // Which fixture this market is for
    pub fixture_id: u64,

    // The YES/NO question text
    pub question: String,

    // Unix timestamp of kickoff (deposits close here)
    pub kickoff_ts: i64,

    // TxLINE stat key for validation (e.g. 1 = home goals)
    pub stat_key: u32,

    // Validation predicate
    pub threshold: u64,
    pub comparison: u8, // 0 = greaterThan, 1 = lessThan

    // Total USDC in each vault (in lamports, 6 decimals)
    pub yes_total: u64,
    pub no_total: u64,

    // Market lifecycle status
    pub status: u8, // 0=open, 1=locked, 2=settled, 3=void

    // Which side won (set at settlement)
    pub winning_side: u8, // 0=YES, 1=NO, 255=not set

    // Who created this market (keeper wallet)
    pub authority: Pubkey,

    // Bump seeds for PDA derivation
    pub bump: u8,
    pub yes_vault_bump: u8,
    pub no_vault_bump: u8,
}

impl Market {
    // Space = discriminator + all fields
    pub const LEN: usize = 8  // discriminator
        + 8   // fixture_id
        + 4 + 200  // question (max 200 chars)
        + 8   // kickoff_ts
        + 4   // stat_key
        + 8   // threshold
        + 1   // comparison
        + 8   // yes_total
        + 8   // no_total
        + 1   // status
        + 1   // winning_side
        + 32  // authority
        + 1   // bump
        + 1   // yes_vault_bump
        + 1;  // no_vault_bump
}
