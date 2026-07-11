use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::KachingError;
use crate::state::market::Market;

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_MARKET, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority @ KachingError::Unauthorized
    )]
    pub market: Account<'info, Market>,
}

pub fn handler(ctx: Context<VoidMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;

    require!(market.status == STATUS_LOCKED, KachingError::MarketNotLocked);

    let seven_days = 7 * 24 * 60 * 60;
    let is_expired = clock.unix_timestamp > market.kickoff_ts + seven_days;
    let is_one_side_empty = market.yes_total == 0 || market.no_total == 0;

    require!(
        is_one_side_empty || is_expired,
        KachingError::CannotVoid
    );

    market.status = STATUS_VOID;
    msg!(
        "Market voided for fixture {} — {}",
        market.fixture_id,
        if is_expired { "expired" } else { "one side empty" }
    );
    Ok(())
}
