// program/src/instructions/claim.rs
// Winner withdraws their proportional share of the pot.
// Payout = (user_stake / winning_total) * losing_total + user_stake

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::constants::*;
use crate::errors::KachingError;
use crate::state::market::Market;
use crate::state::position::Position;

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [SEED_MARKET, &market.fixture_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [SEED_POSITION, &market.fixture_id.to_le_bytes(), user.key().as_ref()],
        bump = position.bump,
        has_one = user
    )]
    pub position: Account<'info, Position>,

    // Winning vault (source of funds)
    #[account(mut)]
    pub winning_vault: Account<'info, TokenAccount>,

    // Losing vault (source of prize funds)
    #[account(mut)]
    pub losing_vault: Account<'info, TokenAccount>,

    // User's USDC account (destination)
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Claim>) -> Result<()> {
    let market = &ctx.accounts.market;
    let position = &mut ctx.accounts.position;

    // Must be settled
    require!(market.status == STATUS_SETTLED, KachingError::MarketNotSettled);

    // Must not have claimed already
    require!(!position.claimed, KachingError::AlreadyClaimed);

    // Must be on the winning side
    require!(position.side == market.winning_side, KachingError::WrongSide);

    // Calculate payout
    // payout = user_stake + (user_stake / winning_total) * losing_total
    let (winning_total, losing_total) = if market.winning_side == SIDE_YES {
        (market.yes_total, market.no_total)
    } else {
        (market.no_total, market.yes_total)
    };

    require!(winning_total > 0, KachingError::NothingToClaim);

    let prize = (position.amount as u128)
        .checked_mul(losing_total as u128).unwrap()
        .checked_div(winning_total as u128).unwrap() as u64;

    let payout = position.amount.checked_add(prize).unwrap();

    // Transfer from winning vault — signed by market PDA
    let fixture_id_bytes = market.fixture_id.to_le_bytes();
    let seeds = &[
        SEED_MARKET,
        &fixture_id_bytes,
        &[market.bump],
    ];
    let signer = &[&seeds[..]];

    // Transfer stake back from winning vault
    let stake_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.winning_vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.market.to_account_info(),
        },
        signer,
    );
    token::transfer(stake_ctx, position.amount)?;

    // Transfer prize from losing vault
    if prize > 0 {
        let prize_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.losing_vault.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer,
        );
        token::transfer(prize_ctx, prize)?;
    }

    position.claimed = true;

    msg!(
        "Claimed {} USDC (stake: {}, prize: {})",
        payout, position.amount, prize
    );
    Ok(())
}
