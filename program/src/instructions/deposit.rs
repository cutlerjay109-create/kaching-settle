// program/src/instructions/deposit.rs
// User locks USDC into YES or NO vault.
// Enforces minimum stake and kickoff deadline.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::constants::*;
use crate::errors::KachingError;
use crate::state::market::Market;
use crate::state::position::Position;

#[derive(Accounts)]
#[instruction(side: u8, amount: u64)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_MARKET, &market.fixture_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    // User's position account (created on first deposit)
    #[account(
        init_if_needed,
        payer = user,
        space = Position::LEN,
        seeds = [SEED_POSITION, &market.fixture_id.to_le_bytes(), user.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,

    // The vault to deposit into (YES or NO)
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    // User's USDC token account
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Deposit>, side: u8, amount: u64) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;

    // Validate market is open
    require!(market.status == STATUS_OPEN, KachingError::MarketNotOpen);

    // Validate kickoff hasn't passed
    require!(clock.unix_timestamp < market.kickoff_ts, KachingError::KickoffPassed);

    // Validate side
    require!(side == SIDE_YES || side == SIDE_NO, KachingError::InvalidSide);

    // Validate amount
    require!(amount >= MIN_STAKE, KachingError::BelowMinimumStake);
    require!(amount <= MAX_STAKE, KachingError::AboveMaximumStake);

    // Transfer USDC from user to vault
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, amount)?;

    // Update market totals
    if side == SIDE_YES {
        market.yes_total = market.yes_total.checked_add(amount).unwrap();
    } else {
        market.no_total = market.no_total.checked_add(amount).unwrap();
    }

    // Record position
    let position = &mut ctx.accounts.position;
    position.fixture_id = market.fixture_id;
    position.user = ctx.accounts.user.key();
    position.side = side;
    position.amount = position.amount.checked_add(amount).unwrap();
    position.claimed = false;
    position.bump = ctx.bumps.position;

    msg!("Deposited {} on side {}", amount, side);
    Ok(())
}
