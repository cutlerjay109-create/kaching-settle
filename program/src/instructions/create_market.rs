// program/src/instructions/create_market.rs
// Opens a new YES/NO market for a fixture.
// Creates the market account and both vaults.

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Mint};
use anchor_spl::associated_token::AssociatedToken;
use crate::constants::*;
use crate::state::market::Market;

#[derive(Accounts)]
#[instruction(fixture_id: u64, question: String)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Market::LEN,
        seeds = [SEED_MARKET, &fixture_id.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,

    // YES vault — holds USDC from YES depositors
    #[account(
        init,
        payer = authority,
        token::mint = usdc_mint,
        token::authority = market,
        seeds = [SEED_YES_VAULT, &fixture_id.to_le_bytes()],
        bump
    )]
    pub yes_vault: Account<'info, TokenAccount>,

    // NO vault — holds USDC from NO depositors
    #[account(
        init,
        payer = authority,
        token::mint = usdc_mint,
        token::authority = market,
        seeds = [SEED_NO_VAULT, &fixture_id.to_le_bytes()],
        bump
    )]
    pub no_vault: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<CreateMarket>,
    fixture_id: u64,
    question: String,
    kickoff_ts: i64,
    stat_key: u32,
    threshold: u64,
    comparison: u8,
) -> Result<()> {
    let market = &mut ctx.accounts.market;

    market.fixture_id = fixture_id;
    market.question = question;
    market.kickoff_ts = kickoff_ts;
    market.stat_key = stat_key;
    market.threshold = threshold;
    market.comparison = comparison;
    market.yes_total = 0;
    market.no_total = 0;
    market.status = STATUS_OPEN;
    market.winning_side = 255; // not set
    market.authority = ctx.accounts.authority.key();
    market.bump = ctx.bumps.market;
    market.yes_vault_bump = ctx.bumps.yes_vault;
    market.no_vault_bump = ctx.bumps.no_vault;

    msg!("Market created for fixture {}", fixture_id);
    Ok(())
}
