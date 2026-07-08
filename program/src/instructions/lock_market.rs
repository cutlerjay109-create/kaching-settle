// program/src/instructions/lock_market.rs
// Seals the market at kickoff — no more deposits allowed.
// Called by the keeper when kickoff time is reached.

use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::KachingError;
use crate::state::market::Market;

#[derive(Accounts)]
pub struct LockMarket<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_MARKET, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority @ KachingError::Unauthorized
    )]
    pub market: Account<'info, Market>,
}

pub fn handler(ctx: Context<LockMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;

    require!(market.status == STATUS_OPEN, KachingError::MarketNotOpen);
    require!(
        clock.unix_timestamp >= market.kickoff_ts,
        KachingError::KickoffNotReached
    );

    market.status = STATUS_LOCKED;
    msg!("Market locked for fixture {}", market.fixture_id);
    Ok(())
}
