// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {ForwarderV4} from "bitgo/ForwarderV4.sol";
import {ForwarderFactoryV4} from "bitgo/ForwarderFactoryV4.sol";
import {SweepBatcher, IForwarderFactoryV4} from "../src/SweepBatcher.sol";
import {DepositSalt} from "../src/DepositSalt.sol";
import {MockUsdtNoReturn, MockSafe} from "./Mocks.sol";

/// 不变量测试的操作者：随机充值、发起账户归集、随机账户乱调、parent 手动 flush、换发起账户
contract SweepHandler is Test {
    SweepBatcher public immutable batcher;
    MockUsdtNoReturn public immutable usdt;
    address public immutable operatorA;
    address public immutable operatorB;
    uint256 public constant USERS = 16;
    uint256 public unauthorizedSuccesses;
    uint256 public parentHigh;

    constructor(SweepBatcher b, MockUsdtNoReturn u, address a, address bOp) {
        batcher = b;
        usdt = u;
        operatorA = a;
        operatorB = bOp;
    }

    function addr(uint256 user) public view returns (address) {
        return batcher.forwarderAddress(DepositSalt.forCustomer(user % USERS));
    }

    function deposit(uint256 user, uint256 amount) external {
        usdt.mint(addr(user), bound(amount, 0, 1e15));
    }

    function sweep(uint256 mask, bool useB) external {
        bytes32[] memory s = new bytes32[](USERS);
        uint256 n;
        for (uint256 i; i < USERS; ++i) if ((mask >> i) & 1 == 1) s[n++] = DepositSalt.forCustomer(i);
        assembly {
            mstore(s, n)
        }
        address op = useB ? operatorB : operatorA;
        vm.prank(op);
        try batcher.sweep(address(usdt), s) {} catch {}
        track();
    }

    function sweepAsStranger(address who, uint256 mask) external {
        if (batcher.isOperator(who)) return;
        bytes32[] memory s = new bytes32[](1);
        s[0] = DepositSalt.forCustomer(mask % USERS);
        vm.prank(who);
        try batcher.sweep(address(usdt), s) {
            unauthorizedSuccesses++;
        } catch {}
    }

    function parentFlush(uint256 user) external {
        address fwd = addr(user);
        if (fwd.code.length == 0) return;
        vm.prank(batcher.parent());
        ForwarderV4(payable(fwd)).flushTokens(address(usdt));
        track();
    }

    function rotate(bool enableB) external {
        vm.prank(batcher.owner());
        batcher.setOperator(operatorB, enableB);
    }

    function forwardersTotal() external view returns (uint256 t) {
        for (uint256 i; i < USERS; ++i) t += usdt.balanceOf(addr(i));
    }

    function track() internal {
        uint256 p = usdt.balanceOf(batcher.parent());
        require(p >= parentHigh, "parent balance decreased");
        parentHigh = p;
    }
}

/// 不变量：批量合约里永远没有代币；所有代币只在转发地址和 parent 之间（转出总额 = 归集前余额合计、收款方只有 parent）；
/// 非发起账户一次也调用不成功；parent 的余额只增不减。
contract SweepBatcherInvariantTest is Test {
    SweepHandler handler;
    SweepBatcher batcher;
    MockUsdtNoReturn usdt;
    MockSafe safe;

    function setUp() public {
        ForwarderV4 impl = new ForwarderV4();
        ForwarderFactoryV4 factory = new ForwarderFactoryV4(address(impl));
        safe = new MockSafe(makeAddr("safeOwner"));
        address opA = makeAddr("operatorA");
        batcher = new SweepBatcher(IForwarderFactoryV4(address(factory)), address(safe), opA);
        usdt = new MockUsdtNoReturn();
        handler = new SweepHandler(batcher, usdt, opA, makeAddr("operatorB"));
        batcher.transferOwnership(address(handler));
        vm.prank(address(handler));
        batcher.acceptOwnership();
        targetContract(address(handler));
    }

    function invariant_batcherHoldsNothing() public view {
        assertEq(usdt.balanceOf(address(batcher)), 0);
        assertEq(address(batcher).balance, 0);
    }

    function invariant_tokensOnlyInForwardersOrParent() public view {
        assertEq(usdt.balanceOf(address(safe)) + handler.forwardersTotal(), usdt.totalSupply());
    }

    function invariant_strangersNeverSucceed() public view {
        assertEq(handler.unauthorizedSuccesses(), 0);
    }

    function invariant_parentNeverDecreases() public view {
        assertGe(usdt.balanceOf(address(safe)), handler.parentHigh());
    }
}
