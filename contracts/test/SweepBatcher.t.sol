// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ForwarderV4} from "bitgo/ForwarderV4.sol";
import {ForwarderFactoryV4} from "bitgo/ForwarderFactoryV4.sol";
import {SweepBatcher, IForwarderFactoryV4} from "../src/SweepBatcher.sol";
import {DepositSalt} from "../src/DepositSalt.sol";
import {MockUsdtNoReturn, MockErc20, MockFalseToken, MockRevertToken, MockSafe, MockBrokenFactory} from "./Mocks.sol";

/// 批量合约 + BitGo 转发合约的完整测试。
contract SweepBatcherTest is Test {
    ForwarderV4 impl;
    ForwarderFactoryV4 factory;
    SweepBatcher batcher;
    MockSafe safe;
    MockUsdtNoReturn usdt;
    MockErc20 bscUsdt;

    address safeOwner = makeAddr("safeOwner");
    address operator = makeAddr("operator");
    address customer = makeAddr("customer");
    address attacker = makeAddr("attacker");

    event Swept(bytes32 indexed salt, address indexed forwarder, bool deployed);
    event SweepFailed(bytes32 indexed salt, address indexed forwarder, bytes reason);
    event OperatorSet(address indexed operator, bool allowed);

    function setUp() public {
        impl = new ForwarderV4();
        factory = new ForwarderFactoryV4(address(impl));
        safe = new MockSafe(safeOwner);
        batcher = new SweepBatcher(IForwarderFactoryV4(address(factory)), address(safe), operator);
        usdt = new MockUsdtNoReturn();
        bscUsdt = new MockErc20(18);
    }

    function salts(uint256 from, uint256 n) internal pure returns (bytes32[] memory s) {
        s = new bytes32[](n);
        for (uint256 i; i < n; ++i) s[i] = DepositSalt.forCustomer(from + i);
    }

    function one(bytes32 salt) internal pure returns (bytes32[] memory s) {
        s = new bytes32[](1);
        s[0] = salt;
    }

    function sweepAs(address who, address token, bytes32[] memory s) internal {
        vm.prank(who);
        batcher.sweep(token, s);
    }

    // ---------- 部署和地址 ----------

    function test_Constructor() public view {
        assertEq(address(batcher.factory()), address(factory));
        assertEq(batcher.parent(), address(safe));
        assertEq(batcher.owner(), address(this));
        assertTrue(batcher.isOperator(operator));
        assertFalse(batcher.isOperator(attacker));
    }

    function test_ConstructorRejectsZeroAddress() public {
        vm.expectRevert(SweepBatcher.ZeroAddress.selector);
        new SweepBatcher(IForwarderFactoryV4(address(0)), address(safe), operator);
        vm.expectRevert(SweepBatcher.ZeroAddress.selector);
        new SweepBatcher(IForwarderFactoryV4(address(factory)), address(0), operator);
        vm.expectRevert(SweepBatcher.ZeroAddress.selector);
        new SweepBatcher(IForwarderFactoryV4(address(factory)), address(safe), address(0));
    }

    /// 地址算法：批量合约算的地址 = BitGo 工厂实际部署出的地址（任意盐、任意 parent）
    function testFuzz_PredictedAddressEqualsFactoryDeployment(bytes32 salt, address parent) public {
        vm.assume(parent != address(0));
        SweepBatcher b = new SweepBatcher(IForwarderFactoryV4(address(factory)), parent, operator);
        address predicted = b.forwarderAddress(salt);
        assertEq(predicted.code.length, 0);
        vm.recordLogs();
        factory.createForwarder(parent, address(b), salt);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (address created,,,,) = abi.decode(logs[logs.length - 1].data, (address, address, address, bool, bool));
        assertEq(created, predicted);
        assertGt(predicted.code.length, 0);
        assertEq(ForwarderV4(payable(predicted)).parentAddress(), parent);
        assertEq(ForwarderV4(payable(predicted)).feeAddress(), address(b));
    }

    // ---------- 归集 ----------

    /// 未部署的地址先收款（这时就是一个普通地址），再批量部署 + 归集
    function test_UndeployedAddressReceivesThenDeployAndSweep() public {
        bytes32 s = DepositSalt.forCustomer(1);
        address fwd = batcher.forwarderAddress(s);
        usdt.mint(customer, 1_000e6);
        vm.prank(customer);
        usdt.transfer(fwd, 250e6);
        assertEq(fwd.code.length, 0, unicode"收款时还没有合约");
        assertEq(usdt.balanceOf(fwd), 250e6);

        vm.expectEmit(true, true, false, true, address(batcher));
        emit Swept(s, fwd, true);
        sweepAs(operator, address(usdt), one(s));

        assertGt(fwd.code.length, 0, unicode"归集时顺便部署");
        assertEq(usdt.balanceOf(fwd), 0);
        assertEq(usdt.balanceOf(address(safe)), 250e6);
        assertEq(usdt.balanceOf(address(batcher)), 0, unicode"批量合约不持有代币");
    }

    function test_DeployedAddressSweepAgain() public {
        bytes32 s = DepositSalt.forCustomer(2);
        address fwd = batcher.forwarderAddress(s);
        usdt.mint(fwd, 100e6);
        sweepAs(operator, address(usdt), one(s));
        usdt.mint(fwd, 300e6);
        vm.expectEmit(true, true, false, true, address(batcher));
        emit Swept(s, fwd, false);
        sweepAs(operator, address(usdt), one(s));
        assertEq(usdt.balanceOf(address(safe)), 400e6);
    }

    function test_MixedBatchDeployedUndeployedEmpty() public {
        bytes32[] memory s = salts(10, 3);
        usdt.mint(batcher.forwarderAddress(s[0]), 5e6);
        sweepAs(operator, address(usdt), one(s[0])); // 第一个先部署
        usdt.mint(batcher.forwarderAddress(s[0]), 7e6);
        usdt.mint(batcher.forwarderAddress(s[1]), 11e6);
        // s[2] 没有余额：照样部署，flushTokens 余额为 0 直接返回
        sweepAs(operator, address(usdt), s);
        assertEq(usdt.balanceOf(address(safe)), 23e6);
        assertGt(batcher.forwarderAddress(s[2]).code.length, 0);
    }

    /// BSC 上的 USDT 是标准 ERC20、18 位小数
    function test_Bsc18DecimalUsdt() public {
        bytes32 s = DepositSalt.forCustomer(3);
        bscUsdt.mint(batcher.forwarderAddress(s), 12.5e18);
        sweepAs(operator, address(bscUsdt), one(s));
        assertEq(bscUsdt.balanceOf(address(safe)), 12.5e18);
    }

    /// 一个地址失败不影响同一批的其他地址（代币回滚、返回 false）
    function test_OneFailureDoesNotAffectOthers() public {
        MockRevertToken bad = new MockRevertToken();
        bytes32[] memory s = salts(20, 2);
        bad.mint(batcher.forwarderAddress(s[0]), 1);
        vm.expectEmit(true, true, false, false, address(batcher));
        emit SweepFailed(s[0], batcher.forwarderAddress(s[0]), "");
        sweepAs(operator, address(bad), s);
        assertGt(batcher.forwarderAddress(s[1]).code.length, 0, unicode"第二个照样部署");

        MockFalseToken f = new MockFalseToken();
        f.mint(batcher.forwarderAddress(s[1]), 5);
        vm.recordLogs();
        sweepAs(operator, address(f), s);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], keccak256("Swept(bytes32,address,bool)"), unicode"s[0] 余额为 0：flushTokens 直接返回，算成功");
        assertEq(logs[1].topics[0], keccak256("SweepFailed(bytes32,address,bytes)"), unicode"s[1] transfer 返回 false：TransferHelper 回滚");
    }

    function test_DeployFailureOnlyEmitsEvent() public {
        MockBrokenFactory broken = new MockBrokenFactory(address(impl));
        SweepBatcher b = new SweepBatcher(IForwarderFactoryV4(address(broken)), address(safe), operator);
        bytes32 s = DepositSalt.forCustomer(4);
        vm.recordLogs();
        vm.prank(operator);
        b.sweep(address(usdt), one(s));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], keccak256("SweepFailed(bytes32,address,bytes)"));
    }

    function test_EmptyList() public {
        sweepAs(operator, address(usdt), new bytes32[](0));
    }

    // ---------- 权限 ----------

    function testFuzz_NonOperatorRejected(address caller) public {
        vm.assume(caller != operator);
        vm.expectRevert(SweepBatcher.NotOperator.selector);
        vm.prank(caller);
        batcher.sweep(address(usdt), salts(1, 1));
    }

    function test_OnlyOwnerSetsOperators() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        batcher.setOperator(attacker, true);
        vm.expectEmit(true, false, false, true, address(batcher));
        emit OperatorSet(attacker, true);
        batcher.setOperator(attacker, true);
        assertTrue(batcher.isOperator(attacker));
    }

    /// 部署后 owner 两步交给 Safe：Safe 接受之前，原 owner 还是 owner
    function test_TwoStepOwnershipToSafe_NoRenounce() public {
        batcher.transferOwnership(address(safe));
        assertEq(batcher.owner(), address(this));
        assertEq(batcher.pendingOwner(), address(safe));
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        batcher.acceptOwnership();
        vm.prank(safeOwner);
        safe.exec(address(batcher), abi.encodeCall(batcher.acceptOwnership, ()));
        assertEq(batcher.owner(), address(safe));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        batcher.setOperator(attacker, true);
        vm.prank(address(safe));
        vm.expectRevert(SweepBatcher.RenounceDisabled.selector);
        batcher.renounceOwnership();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        batcher.renounceOwnership();
    }

    /// 发起账户换了（第 4.13.4 节）：老地址不用换，新账户照样能归集老地址，旧账户被拒绝
    function test_OperatorRotationKeepsOldAddresses() public {
        bytes32 s = DepositSalt.forCustomer(5);
        address fwd = batcher.forwarderAddress(s);
        usdt.mint(fwd, 10e6);
        sweepAs(operator, address(usdt), one(s));
        address newOp = makeAddr("newOperator");
        batcher.setOperator(operator, false);
        batcher.setOperator(newOp, true);
        assertEq(batcher.forwarderAddress(s), fwd, unicode"发起账户不在地址算法里");
        usdt.mint(fwd, 20e6);
        vm.expectRevert(SweepBatcher.NotOperator.selector);
        sweepAs(operator, address(usdt), one(s));
        sweepAs(newOp, address(usdt), one(s));
        // 还没部署的老地址：新账户也能部署 + 归集
        bytes32 s2 = DepositSalt.forCustomer(6);
        usdt.mint(batcher.forwarderAddress(s2), 3e6);
        sweepAs(newOp, address(usdt), one(s2));
        assertEq(usdt.balanceOf(address(safe)), 33e6);
    }

    /// 换批量合约 = 换 feeAddress：同一个盐算出的是另一个地址；老地址只认老批量合约，所以老批量合约要一直保留（第 4.13.2 节）
    function test_NewBatcherCannotSweepOldAddresses() public {
        bytes32 s = DepositSalt.forCustomer(7);
        address oldFwd = batcher.forwarderAddress(s);
        usdt.mint(oldFwd, 9e6);
        sweepAs(operator, address(usdt), one(s)); // 部署
        usdt.mint(oldFwd, 4e6);
        SweepBatcher b2 = new SweepBatcher(IForwarderFactoryV4(address(factory)), address(safe), operator);
        assertTrue(b2.forwarderAddress(s) != oldFwd);
        vm.prank(address(b2));
        vm.expectRevert("Address is not allowed");
        ForwarderV4(payable(oldFwd)).flushTokens(address(usdt));
        vm.prank(operator);
        b2.sweep(address(usdt), one(s)); // 部署的是新地址，老地址的钱不动
        assertEq(usdt.balanceOf(oldFwd), 4e6);
        sweepAs(operator, address(usdt), one(s));
        assertEq(usdt.balanceOf(address(safe)), 13e6);
    }

    // ---------- 兜底：parent（Safe）自己归集（两个原先没核实的问题，这里实测） ----------

    /// 实测 1：parent 可以直接调用转发合约的 flushTokens（onlyAllowedAddress = parent 或 feeAddress）
    function test_ParentCanFlushDirectly() public {
        bytes32 s = DepositSalt.forCustomer(8);
        address fwd = batcher.forwarderAddress(s);
        usdt.mint(fwd, 1e6);
        sweepAs(operator, address(usdt), one(s));
        usdt.mint(fwd, 2e6);
        vm.prank(safeOwner);
        safe.exec(fwd, abi.encodeCall(ForwarderV4.flushTokens, (address(usdt))));
        assertEq(usdt.balanceOf(address(safe)), 3e6);
        vm.prank(attacker);
        vm.expectRevert("Address is not allowed");
        ForwarderV4(payable(fwd)).flushTokens(address(usdt));
        vm.prank(operator);
        vm.expectRevert("Address is not allowed");
        ForwarderV4(payable(fwd)).flushTokens(address(usdt));
    }

    /// 实测 2：createForwarder 任何人都能调用；没部署的地址 Safe 自己部署再 flush（批量合约坏了时的兜底）
    function test_AnyoneCanCreateForwarder_SafeDeploysThenFlushes() public {
        bytes32 s = DepositSalt.forCustomer(9);
        address fwd = batcher.forwarderAddress(s);
        usdt.mint(fwd, 6e6);
        vm.startPrank(safeOwner);
        safe.exec(address(factory), abi.encodeWithSignature("createForwarder(address,address,bytes32)", address(safe), address(batcher), s));
        safe.exec(fwd, abi.encodeCall(ForwarderV4.flushTokens, (address(usdt))));
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(safe)), 6e6);
    }

    /// 抢先部署：攻击者用同样的参数部署 = 同一个地址、同样的 parent 和 feeAddress，还替我们付了 gas；批量合约照常归集
    function test_FrontRunDeployIsHarmless() public {
        bytes32 s = DepositSalt.forCustomer(11);
        address fwd = batcher.forwarderAddress(s);
        usdt.mint(fwd, 8e6);
        vm.prank(attacker);
        factory.createForwarder(address(safe), address(batcher), s, false, false); // 5 个参数的版本，自动转 NFT 关掉：盐里没有这两个开关，地址不变
        assertGt(fwd.code.length, 0);
        assertEq(ForwarderV4(payable(fwd)).parentAddress(), address(safe));
        assertEq(ForwarderV4(payable(fwd)).feeAddress(), address(batcher));
        vm.expectEmit(true, true, false, true, address(batcher));
        emit Swept(s, fwd, false);
        sweepAs(operator, address(usdt), one(s));
        assertEq(usdt.balanceOf(address(safe)), 8e6);
        // 同一个地址不能再部署第二次
        vm.expectRevert();
        factory.createForwarder(address(safe), address(batcher), s);
        // 攻击者换成自己的 parent：算出的是另一个地址，我们的地址不受影响
        vm.prank(attacker);
        factory.createForwarder(attacker, address(batcher), s);
        assertEq(ForwarderV4(payable(fwd)).parentAddress(), address(safe));
    }

    /// 实现合约本身没有初始化，任何人都能 init 它；这不影响任何转发地址（转发地址用自己的存储）
    function test_InitializingImplementationDoesNotAffectForwarders() public {
        vm.prank(attacker);
        impl.init(attacker, attacker, true, true);
        assertEq(impl.parentAddress(), attacker);
        bytes32 s = DepositSalt.forCustomer(12);
        usdt.mint(batcher.forwarderAddress(s), 1e6);
        sweepAs(operator, address(usdt), one(s));
        assertEq(usdt.balanceOf(address(safe)), 1e6);
        assertEq(ForwarderV4(payable(batcher.forwarderAddress(s))).parentAddress(), address(safe));
    }

    // ---------- 客户误转 ----------

    /// 误转原生币（ETH / BNB）：没部署时先存在地址上，部署时 init 自动转给 parent；部署后再转直接转给 parent；
    /// 被强制塞进来的（例如 selfdestruct）任何人都可以调用 flush() 转给 parent
    function test_StrayNativeCoin() public {
        bytes32 s = DepositSalt.forCustomer(13);
        address payable fwd = payable(batcher.forwarderAddress(s));
        vm.deal(customer, 10 ether);
        vm.prank(customer);
        (bool ok,) = fwd.call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(fwd.balance, 1 ether);
        sweepAs(operator, address(usdt), one(s));
        assertEq(address(safe).balance, 1 ether, unicode"部署时 init 转给 parent");
        vm.prank(customer);
        (ok,) = fwd.call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(address(safe).balance, 3 ether, unicode"部署后 receive 自动转给 parent");
        vm.deal(fwd, 0.5 ether);
        vm.prank(attacker);
        ForwarderV4(fwd).flush();
        assertEq(address(safe).balance, 3.5 ether);
        assertEq(address(batcher).balance, 0);
    }

    /// 只给 2,300 gas 的 transfer 往已部署的转发地址转原生币会失败（我们不收原生币充值）
    function test_Transfer2300ToDeployedForwarderFails() public {
        bytes32 s = DepositSalt.forCustomer(14);
        address payable fwd = payable(batcher.forwarderAddress(s));
        sweepAs(operator, address(usdt), one(s));
        Sender2300 sender = new Sender2300();
        vm.deal(address(sender), 1 ether);
        vm.expectRevert();
        sender.send2300(fwd);
    }

    /// 误转其他 ERC20：同一个批量合约换个代币地址就能归集到 parent（不入账）
    function test_StrayOtherErc20() public {
        MockErc20 other = new MockErc20(8);
        bytes32[] memory s = salts(30, 2);
        other.mint(batcher.forwarderAddress(s[0]), 77);
        usdt.mint(batcher.forwarderAddress(s[1]), 5e6);
        sweepAs(operator, address(usdt), s);
        sweepAs(operator, address(other), s);
        assertEq(other.balanceOf(address(safe)), 77);
        assertEq(usdt.balanceOf(address(safe)), 5e6);
    }

    /// 批量合约不收原生币（没有 receive / payable）
    function test_BatcherRejectsNativeCoin() public {
        vm.deal(customer, 1 ether);
        vm.prank(customer);
        (bool ok,) = address(batcher).call{value: 1}("");
        assertFalse(ok);
    }

    // ---------- 模糊测试：归集前后金额守恒，收款方只有 parent ----------

    function testFuzz_AmountConservedAndOnlyParentReceives(uint256 seed, uint8 n, uint8 deployedMask) public {
        n = uint8(bound(n, 1, 12));
        bytes32[] memory s = new bytes32[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            s[i] = keccak256(abi.encode(seed, i));
            uint256 amount = uint256(keccak256(abi.encode(seed, i, "amount"))) % 1e15;
            address fwd = batcher.forwarderAddress(s[i]);
            if ((deployedMask >> (i % 8)) & 1 == 1) {
                vm.prank(operator);
                batcher.sweep(address(usdt), one(s[i])); // 先部署
            }
            usdt.mint(fwd, amount);
            total += amount;
        }
        vm.recordLogs();
        sweepAs(operator, address(usdt), s);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 moved;
        bytes32 transferTopic = keccak256("Transfer(address,address,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(usdt) || logs[i].topics[0] != transferTopic) continue;
            assertEq(address(uint160(uint256(logs[i].topics[2]))), address(safe), unicode"收款方只能是 parent");
            moved += abi.decode(logs[i].data, (uint256));
        }
        assertEq(moved, total);
        assertEq(usdt.balanceOf(address(safe)), total);
        assertEq(usdt.balanceOf(address(batcher)), 0);
        for (uint256 i; i < n; ++i) assertEq(usdt.balanceOf(batcher.forwarderAddress(s[i])), 0);
    }

    // ---------- gas 实测（forge test -vv 看日志） ----------

    function test_GasMeasurement() public {
        uint256[4] memory sizes = [uint256(1), 10, 50, 100];
        for (uint256 k; k < sizes.length; ++k) {
            bytes32[] memory s = salts(1000 * (k + 1), sizes[k]);
            for (uint256 i; i < s.length; ++i) usdt.mint(batcher.forwarderAddress(s[i]), 100e6);
            vm.prank(operator);
            uint256 g = gasleft();
            batcher.sweep(address(usdt), s);
            uint256 firstTime = g - gasleft();
            for (uint256 i; i < s.length; ++i) usdt.mint(batcher.forwarderAddress(s[i]), 100e6);
            vm.prank(operator);
            g = gasleft();
            batcher.sweep(address(usdt), s);
            uint256 again = g - gasleft();
            emit log_named_uint(string.concat("addresses ", vm.toString(sizes[k]), " first (deploy+flush) gas"), firstTime);
            emit log_named_uint(string.concat("addresses ", vm.toString(sizes[k]), " deployed (flush) gas"), again);
            // 后端估算用的每地址 gas（wallet/sweep/SweepFees.java）必须不低于实测：首次 ≤ 160,000、已部署 ≤ 45,000（不含 21,000 基础）
            assertLt(firstTime, sizes[k] * 160_000);
            assertLt(again, sizes[k] * 45_000);
        }
    }
}

/// 用 2,300 gas 的 transfer 转原生币
contract Sender2300 {
    function send2300(address payable to) external {
        to.transfer(1);
    }
}
