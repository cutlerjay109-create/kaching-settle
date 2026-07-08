// program/src/lib.rs
use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod kaching_settle {
    use super::*;

    pub fn create_market(
        ctx: Context<CreateMarket>,
        fixture_id: u64,
        question: String,
        kickoff_ts: i64,
        stat_key: u32,
        threshold: u64,
        comparison: u8,
    ) -> Result<()> {
        instructions::create_market::handler(
            ctx, fixture_id, question, kickoff_ts, stat_key, threshold, comparison
        )
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        side: u8,
        amount: u64,
    ) -> Result<()> {
        instructions::deposit::handler(ctx, side, amount)
    }

    pub fn lock_market(ctx: Context<LockMarket>) -> Result<()> {
        instructions::lock_market::handler(ctx)
    }

    pub fn settle(
        ctx: Context<Settle>,
        winning_side: u8,
    ) -> Result<()> {
        instructions::settle::handler(ctx, winning_side)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handler(ctx)
    }
}
