// program/src/instructions/settle.rs
// Records which side won after the keeper verifies the TxLINE proof.
// The keeper calls validateStat().view() off-chain and passes the result here.
// The proof itself is stored off-chain as the verifiable receipt.

use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::KachingError;
use crate::state::market::Market;

#[derive(Accounts)]
pub struct Settle<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_MARKET, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority @ KachingError::Unauthorized
    )]
    pub market: Account<'info, Market>,
}

pub fn handler(ctx: Context<Settle>, winning_side: u8) -> Result<()> {
    let market = &mut ctx.accounts.market;

    require!(market.status == STATUS_LOCKED, KachingError::MarketNotLocked);
    require!(
        winning_side == SIDE_YES || winning_side == SIDE_NO,
        KachingError::InvalidSide
    );

    market.winning_side = winning_side;
    market.status = STATUS_SETTLED;

    msg!(
        "Market settled: fixture {} — {} wins",
        market.fixture_id,
        if winning_side == SIDE_YES { "YES" } else { "NO" }
    );
    Ok(())
}
