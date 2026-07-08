// program/src/lib.rs
// Entry point for the kaching-settle Solana program.
// Registers all instructions.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("PLACEHOLDER_PROGRAM_ID");

#[program]
pub mod kaching_settle {
    use super::*;

    // Open a new YES/NO market for a fixture
    pub fn create_market(
        ctx: Context<CreateMarket>,
        fixture_id: u64,
        question: String,
        kickoff_ts: i64,
        stat_key: u32,
        threshold: u64,
        comparison: u8, // 0 = greaterThan, 1 = lessThan
    ) -> Result<()> {
        instructions::create_market::handler(
            ctx, fixture_id, question, kickoff_ts, stat_key, threshold, comparison
        )
    }

    // User deposits USDC into YES or NO vault
    pub fn deposit(
        ctx: Context<Deposit>,
        side: u8, // 0 = YES, 1 = NO
        amount: u64,
    ) -> Result<()> {
        instructions::deposit::handler(ctx, side, amount)
    }

    // Lock the market at kickoff — no more deposits
    pub fn lock_market(ctx: Context<LockMarket>) -> Result<()> {
        instructions::lock_market::handler(ctx)
    }

    // Record the winning side after keeper verifies the proof
    pub fn settle(
        ctx: Context<Settle>,
        winning_side: u8, // 0 = YES, 1 = NO
    ) -> Result<()> {
        instructions::settle::handler(ctx, winning_side)
    }

    // Winner claims their proportional share
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handler(ctx)
    }
}
