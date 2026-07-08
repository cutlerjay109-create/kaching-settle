// program/src/errors.rs
// Clear error messages for every failure mode.

use anchor_lang::prelude::*;

#[error_code]
pub enum KachingError {
    #[msg("Market is not open for deposits")]
    MarketNotOpen,

    #[msg("Market is not locked — kickoff has not happened yet")]
    MarketNotLocked,

    #[msg("Market is not settled yet")]
    MarketNotSettled,

    #[msg("Deposit amount is below the $1 minimum")]
    BelowMinimumStake,

    #[msg("Deposit amount exceeds the $10,000 maximum")]
    AboveMaximumStake,

    #[msg("Kickoff time has not been reached yet")]
    KickoffNotReached,

    #[msg("Kickoff has already passed — deposits closed")]
    KickoffPassed,

    #[msg("Invalid side — must be 0 (YES) or 1 (NO)")]
    InvalidSide,

    #[msg("This position has already claimed")]
    AlreadyClaimed,

    #[msg("This position was on the losing side")]
    WrongSide,

    #[msg("No funds to claim")]
    NothingToClaim,

    #[msg("Unauthorized — only the keeper can settle")]
    Unauthorized,
}
