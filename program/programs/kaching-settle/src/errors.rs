use anchor_lang::prelude::*;

#[error_code]
pub enum KachingError {
    #[msg("Market is not open for deposits")]
    MarketNotOpen,

    #[msg("Market is not locked yet")]
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

    #[msg("Cannot void — both sides have funds and market has not expired")]
    CannotVoid,

    #[msg("Market is not voided")]
    MarketNotVoid,

    #[msg("Already refunded")]
    AlreadyRefunded,

    #[msg("You already have a position on the other side")]
    SideMismatch,

    #[msg("Market expired — kickoff was more than 7 days ago")]
    MarketExpired,
}
