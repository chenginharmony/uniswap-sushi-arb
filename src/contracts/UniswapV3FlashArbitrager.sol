// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title UniswapV3FlashArbitrager
/// @notice Base-mainnet two-leg arbitrage executor funded by a Uniswap V3 flash loan.
/// @dev Critical routing configuration is immutable. The executor only accepts the
///      canonical Base Uniswap SwapRouter02 and PancakeSwap V3 router.

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);

    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external;
}

interface IUniswapSwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);
}

interface IPancakeSwapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);
}

interface IAerodromeSlipstreamRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);
}

contract UniswapV3FlashArbitrager {
    // Base mainnet canonical addresses.
    address public constant UNISWAP_V3_FACTORY =
        0x33128a8fC17869897dcE68Ed026d694621f6FDfD;

    address public constant UNISWAP_ROUTER02 =
        0x2626664c2603336E57B271c5C0b26F421741e481;

    address public constant PANCAKESWAP_V3_ROUTER =
        0x1b81D678ffb9C0263b24A97847620C99d213eB14;

    address public constant AERODROME_SLIPSTREAM_ROUTER =
        0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;

    address public immutable owner;

    // Non-zero only during the synchronous flash callback.
    address private activeFlashPool;
    bool private executing;

    error NotOwner();
    error Reentrancy();
    error DeadlineExpired();
    error ZeroBorrowAmount();
    error InvalidAddress();
    error InvalidBorrowToken();
    error InvalidIntermediateToken();
    error InvalidRouter();
    error InvalidFlashPool();
    error FlashPoolNotCanonical();
    error InvalidPoolFee();
    error InvalidRouteFee();
    error ApprovalFailed();
    error TransferFailed();
    error InsufficientProfit();
    error CallbackCallerMismatch();
    error CallbackPoolMismatch();
    error InvalidCallbackState();
    error Leg1Slippage();
    error Leg2Slippage();
    error RescueDuringExecution();

    struct FlashArbParams {
        address flashPool;
        address borrowToken;
        uint256 borrowAmount;

        address router1;
        uint24 feeTier1;
        uint256 minAmountOut1;

        address router2;
        uint24 feeTier2;
        uint256 minAmountOut2;

        address intermediateToken;
        uint256 minProfitSurplus;
        uint256 deadline;
    }

    event FlashArbitrageExecuted(
        address indexed flashPool,
        address indexed borrowToken,
        address indexed recipient,
        uint256 borrowAmount,
        uint256 repaymentAmount,
        uint256 netProfit
    );

    event TokensRescued(
        address indexed token,
        address indexed recipient,
        uint256 amount
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (executing) revert Reentrancy();
        executing = true;
        _;
        executing = false;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Starts a flash-loan arbitrage.
    /// @dev The caller is the only profit recipient. No arbitrary recipient is accepted.
    function executeFlashArb(
        FlashArbParams calldata params
    ) external onlyOwner nonReentrant {
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (params.borrowAmount == 0) revert ZeroBorrowAmount();

        _validateRouter(params.router1);
        _validateRouter(params.router2);

        if (params.flashPool == address(0)) revert InvalidAddress();
        if (params.borrowToken == address(0) || params.intermediateToken == address(0)) {
            revert InvalidAddress();
        }
        if (params.borrowToken == params.intermediateToken) {
            revert InvalidIntermediateToken();
        }

        IUniswapV3Pool pool = IUniswapV3Pool(params.flashPool);
        address token0 = pool.token0();
        address token1 = pool.token1();
        uint24 poolFee = pool.fee();

        if (params.borrowToken != token0 && params.borrowToken != token1) {
            revert InvalidBorrowToken();
        }
        if (params.intermediateToken != token0 && params.intermediateToken != token1) {
            revert InvalidIntermediateToken();
        }
        if (params.borrowToken == params.intermediateToken) {
            revert InvalidRouteFee();
        }

        // The flash lender must be the canonical Base Uniswap V3 pool for
        // its exact token pair and fee tier.
        address canonicalPool =
            IUniswapV3Factory(UNISWAP_V3_FACTORY).getPool(token0, token1, poolFee);

        if (canonicalPool != params.flashPool) revert FlashPoolNotCanonical();
        if (poolFee == 0) revert InvalidPoolFee();

        // Each swap must actually move between the two route assets.
        // The router itself remains responsible for finding the specified
        // fee-tier pool.
        if (params.router1 == params.router2) {
            // Same router is permitted; different fee tiers/pools can still
            // represent a valid arbitrage.
        }

        activeFlashPool = params.flashPool;

        uint256 amount0 = params.borrowToken == token0 ? params.borrowAmount : 0;
        uint256 amount1 = params.borrowToken == token1 ? params.borrowAmount : 0;

        pool.flash(
            address(this),
            amount0,
            amount1,
            abi.encode(params, msg.sender)
        );

        // Normally reached only after the callback has repaid the pool.
        activeFlashPool = address(0);
    }

    /// @notice Uniswap V3 flash callback. Callable only by the exact pool
    ///         locked immediately before pool.flash().
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external {
        if (msg.sender != activeFlashPool) revert CallbackCallerMismatch();
        if (!executing || activeFlashPool == address(0)) revert InvalidCallbackState();

        (
            FlashArbParams memory params,
            address recipient
        ) = abi.decode(data, (FlashArbParams, address));

        if (params.flashPool != msg.sender) revert CallbackPoolMismatch();
        if (recipient != owner) revert NotOwner();

        IUniswapV3Pool pool = IUniswapV3Pool(msg.sender);
        address token0 = pool.token0();
        address token1 = pool.token1();

        uint256 flashFee;
        if (params.borrowToken == token0) {
            flashFee = fee0;
        } else if (params.borrowToken == token1) {
            flashFee = fee1;
        } else {
            revert InvalidBorrowToken();
        }

        uint256 repayment = params.borrowAmount + flashFee;

        // Snapshot the borrow-token balance after the flash loan has arrived.
        // This prevents pre-existing trapped funds from being counted as
        // arbitrage output/profit.
        uint256 borrowBalanceBeforeSwaps =
            IERC20Minimal(params.borrowToken).balanceOf(address(this));

        uint256 intermediateReceived = _executeSwap(
            params.router1,
            params.borrowToken,
            params.intermediateToken,
            params.feeTier1,
            params.borrowAmount,
            params.minAmountOut1,
            params.deadline
        );

        if (intermediateReceived < params.minAmountOut1) {
            revert Leg1Slippage();
        }

        uint256 finalReceived = _executeSwap(
            params.router2,
            params.intermediateToken,
            params.borrowToken,
            params.feeTier2,
            intermediateReceived,
            params.minAmountOut2,
            params.deadline
        );

        if (finalReceived < params.minAmountOut2) {
            revert Leg2Slippage();
        }

        uint256 borrowBalanceAfterSwaps =
            IERC20Minimal(params.borrowToken).balanceOf(address(this));

        // Only the increase in borrow-token balance caused by this execution
        // may fund repayment/profit.
        uint256 executionOutput;
        if (borrowBalanceAfterSwaps < borrowBalanceBeforeSwaps) {
            revert InsufficientProfit();
        }
        executionOutput =
            borrowBalanceAfterSwaps - borrowBalanceBeforeSwaps;

        if (executionOutput < repayment + params.minProfitSurplus) {
            revert InsufficientProfit();
        }

        _safeTransfer(params.borrowToken, msg.sender, repayment);

        uint256 netProfit = executionOutput - repayment;
        if (netProfit < params.minProfitSurplus) {
            revert InsufficientProfit();
        }

        if (netProfit != 0) {
            _safeTransfer(params.borrowToken, recipient, netProfit);
        }

        emit FlashArbitrageExecuted(
            params.flashPool,
            params.borrowToken,
            recipient,
            params.borrowAmount,
            repayment,
            netProfit
        );
    }

    function _validateRouter(address router) internal pure {
        if (
            router != UNISWAP_ROUTER02 &&
            router != PANCAKESWAP_V3_ROUTER &&
            router != AERODROME_SLIPSTREAM_ROUTER
        ) {
            revert InvalidRouter();
        }
    }

    function _executeSwap(
        address router,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        _validateRouter(router);

        if (
            tokenIn == address(0) ||
            tokenOut == address(0) ||
            tokenIn == tokenOut ||
            amountIn == 0
        ) {
            revert InvalidAddress();
        }

        // Approve only the exact amount needed for this leg.
        _forceApprove(tokenIn, router, amountIn);

        if (router == PANCAKESWAP_V3_ROUTER) {
            return IPancakeSwapV3Router(router).exactInputSingle(
                IPancakeSwapV3Router.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: address(this),
                    deadline: deadline,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMinimum,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        if (router == AERODROME_SLIPSTREAM_ROUTER) {
            return IAerodromeSlipstreamRouter(router).exactInputSingle(
                IAerodromeSlipstreamRouter.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    tickSpacing: int24(int256(uint256(fee))),
                    recipient: address(this),
                    deadline: deadline,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMinimum,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        return IUniswapSwapRouter02(router).exactInputSingle(
            IUniswapSwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /// @dev Handles ERC-20s that return true and tokens that return no value.
    function _safeTransfer(
        address token,
        address to,
        uint256 amount
    ) internal {
        (bool ok, bytes memory returndata) =
            token.call(
                abi.encodeWithSelector(
                    bytes4(keccak256("transfer(address,uint256)")),
                    to,
                    amount
                )
            );

        if (!ok || (returndata.length != 0 &&
            (returndata.length != 32 ||
                abi.decode(returndata, (bool)) == false))) {
            revert TransferFailed();
        }
    }

    /// @dev Zeroes the allowance first, then sets the exact allowance.
    function _forceApprove(
        address token,
        address spender,
        uint256 amount
    ) internal {
        _callOptionalReturn(
            token,
            abi.encodeWithSelector(
                bytes4(keccak256("approve(address,uint256)")),
                spender,
                0
            )
        );

        _callOptionalReturn(
            token,
            abi.encodeWithSelector(
                bytes4(keccak256("approve(address,uint256)")),
                spender,
                amount
            )
        );
    }

    function _callOptionalReturn(
        address token,
        bytes memory callData
    ) internal {
        (bool ok, bytes memory returndata) = token.call(callData);

        if (!ok || (returndata.length != 0 &&
            (returndata.length != 32 ||
                abi.decode(returndata, (bool)) == false))) {
            revert ApprovalFailed();
        }
    }

    /// @notice Recovers tokens accidentally left in the executor.
    /// @dev Cannot run during an active flash execution.
    function rescueTokens(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (executing || activeFlashPool != address(0)) {
            revert RescueDuringExecution();
        }
        if (token == address(0) || to == address(0)) revert InvalidAddress();

        _safeTransfer(token, to, amount);
        emit TokensRescued(token, to, amount);
    }

    function getActiveFlashPool() external view returns (address) {
        return activeFlashPool;
    }

    function isExecuting() external view returns (bool) {
        return executing;
    }
}
