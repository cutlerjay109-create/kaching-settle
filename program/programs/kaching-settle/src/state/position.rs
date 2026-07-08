// program/src/state/position.rs
// One position per user per market.
// Tracks which side they bet on, how much, and if they claimed.

use anchor_lang::prelude::*;

#[account]
pub struct Position {
    // Which market
    pub fixture_id: u64,

    // The user's wallet
    pub user: Pubkey,

    // Which side: 0 = YES, 1 = NO
    pub side: u8,

    // How much USDC they deposited (6 decimals)
    pub amount: u64,

    // Whether they've already claimed
    pub claimed: bool,

    // Bump for PDA derivation
    pub bump: u8,
}

impl Position {
    pub const LEN: usize = 8  // discriminator
        + 8   // fixture_id
        + 32  // user
        + 1   // side
        + 8   // amount
        + 1   // claimed
        + 1;  // bump
}
