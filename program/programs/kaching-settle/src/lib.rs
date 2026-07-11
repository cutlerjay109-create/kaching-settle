use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B");

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

    pub fn deposit(ctx: Context<Deposit>, side: u8, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, side, amount)
    }

    pub fn lock_market(ctx: Context<LockMarket>) -> Result<()> {
        instructions::lock_market::handler(ctx)
    }

    pub fn settle(ctx: Context<Settle>, winning_side: u8) -> Result<()> {
        instructions::settle::handler(ctx, winning_side)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handler(ctx)
    }

    pub fn void_market(ctx: Context<VoidMarket>) -> Result<()> {
        instructions::void_market::handler(ctx)
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        instructions::refund::handler(ctx)
    }
}
