// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

// 测试先写（第 3 批）：BatchPayout 的不变量（技术方案 05 页第 5 节）：
//   ① 合约永远不持有代币和原生币；② 每次成功的 pay：热钱包减少 = 收款人增加之和 = 输入之和；
//   ③ 非登记账户一次也调用不成功；④ A 热钱包的额度不会被 B 用掉（A 的额度只随 A 自己的 pay 减少）。
// 操作者随机：A / B 打款（含超额、拉黑收款人导致整批失败）、陌生人乱调、owner 撤销 / 重新登记 B、往合约转币。

import {Test} from "forge-std/Test.sol";
import {BatchPayout} from "../src/BatchPayout.sol";
import {MockUsdtTF} from "./PayoutMocks.sol";

contract PayoutHandler is Test {
    BatchPayout public immutable bp;
    MockUsdtTF public immutable usdt;
    address public immutable a;
    address public immutable b;
    address public immutable owner;
    uint256 public unauthorizedSuccesses;
    uint256 public conservationBreaks;
    uint256 public paidByA;
    uint256 public allowanceA0;
    uint256 public constant RECIPIENTS = 12;

    constructor(BatchPayout bp_, MockUsdtTF u, address a_, address b_, address owner_) {
        bp = bp_;
        usdt = u;
        a = a_;
        b = b_;
        owner = owner_;
        allowanceA0 = u.allowance(a_, address(bp_));
    }

    function recipient(uint256 i) public pure returns (address) {
        return address(uint160(0xA0000 + (i % RECIPIENTS)));
    }

    function pay(bool useB, uint256 mask, uint256 each, bool poison) external {
        address who = useB ? b : a;
        uint256 n;
        for (uint256 i; i < RECIPIENTS; ++i) if ((mask >> i) & 1 == 1) n++;
        if (n == 0) return;
        address[] memory to = new address[](n);
        uint256[] memory amt = new uint256[](n);
        uint256 k;
        uint256 sum;
        for (uint256 i; i < RECIPIENTS; ++i) {
            if ((mask >> i) & 1 == 1) {
                to[k] = recipient(i);
                amt[k] = bound(each, 0, 2_000e6) + k;
                sum += amt[k];
                k++;
            }
        }
        if (poison) usdt.block_(to[n - 1], true);
        uint256 hotBefore = usdt.balanceOf(who);
        uint256 recvBefore;
        for (uint256 i; i < RECIPIENTS; ++i) recvBefore += usdt.balanceOf(recipient(i));
        vm.prank(who);
        try bp.pay(address(usdt), keccak256(abi.encode(mask)), to, amt) {
            uint256 recvAfter;
            for (uint256 i; i < RECIPIENTS; ++i) recvAfter += usdt.balanceOf(recipient(i));
            if (hotBefore - usdt.balanceOf(who) != sum || recvAfter - recvBefore != sum) conservationBreaks++;
            if (who == a) paidByA += sum;
        } catch {
            if (usdt.balanceOf(who) != hotBefore) conservationBreaks++;
        }
        if (poison) usdt.block_(to[n - 1], false);
    }

    function stranger(address who, uint256 each) external {
        if (bp.isPayer(who)) return;
        address[] memory to = new address[](1);
        uint256[] memory amt = new uint256[](1);
        to[0] = recipient(each);
        amt[0] = bound(each, 0, 1e6);
        vm.prank(who);
        try bp.pay(address(usdt), bytes32(0), to, amt) {
            unauthorizedSuccesses++;
        } catch {}
    }

    function toggleB(bool allowed) external {
        vm.prank(owner);
        bp.setPayer(b, allowed);
    }
}

contract BatchPayoutInvariant is Test {
    BatchPayout internal bp;
    MockUsdtTF internal usdt;
    PayoutHandler internal h;
    address internal a = makeAddr("hotA");
    address internal b = makeAddr("hotB");

    function setUp() public {
        bp = new BatchPayout(a);
        bp.setPayer(b, true);
        usdt = new MockUsdtTF();
        usdt.mint(a, 1e18);
        usdt.mint(b, 1e18);
        vm.prank(a);
        usdt.approve(address(bp), 50_000e6);
        vm.prank(b);
        usdt.approve(address(bp), 50_000e6);
        h = new PayoutHandler(bp, usdt, a, b, address(this));
        bp.transferOwnership(address(h));
        vm.prank(address(h));
        bp.acceptOwnership();
        targetContract(address(h));
    }

    function invariant_holdsNothing() public view {
        assertEq(usdt.balanceOf(address(bp)), 0);
        assertEq(address(bp).balance, 0);
    }

    function invariant_conservation() public view {
        assertEq(h.conservationBreaks(), 0);
    }

    function invariant_strangersNeverSucceed() public view {
        assertEq(h.unauthorizedSuccesses(), 0);
    }

    function invariant_allowanceOfAOnlyUsedByA() public view {
        assertEq(usdt.allowance(a, address(bp)), h.allowanceA0() - h.paidByA());
    }
}
