use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::constants::*;
use crate::errors::KachingError;
use crate::state::market::Market;
use crate::state::position::Position;

#[derive(Accounts)]
pub struct Refund<'info> {
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

    #[account(mut)]
    pub user_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Refund>) -> Result<()> {
    let market = &ctx.accounts.market;
    let position = &mut ctx.accounts.position;

    require!(market.status == STATUS_VOID, KachingError::MarketNotVoid);
    require!(!position.claimed, KachingError::AlreadyRefunded);

    let refund_amount = position.amount;
    require!(refund_amount > 0, KachingError::NothingToClaim);

    let fixture_id_bytes = market.fixture_id.to_le_bytes();
    let seeds = &[SEED_MARKET, &fixture_id_bytes, &[market.bump]];
    let signer = &[&seeds[..]];

    let refund_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.user_vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.market.to_account_info(),
        },
        signer,
    );
    token::transfer(refund_ctx, refund_amount)?;

    position.claimed = true;
    msg!("Refunded {} USDC to user", refund_amount);
    Ok(())
}
