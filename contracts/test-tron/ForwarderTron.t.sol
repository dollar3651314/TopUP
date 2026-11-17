// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

import {Test, Vm} from "forge-std/Test.sol";
import {ForwarderTron} from "../src/tron/ForwarderTron.sol";
import {ForwarderFactoryTron} from "../src/tron/ForwarderFactoryTron.sol";
import {SweepBatcherTron} from "../src/tron/SweepBatcherTron.sol";
import {SweepBatcher, IForwarderFactoryV4} from "../src/SweepBatcher.sol";
import {MockErc20, MockUsdtNoReturn, MockFalseToken, MockRevertToken, MockSafe} from "../test/Mocks.sol";
import {TronUsdtMock, LyingToken, FeeOnTransferToken} from "./TronMocks.sol";

/// 测试先写（第 2 批）：BitGo 转发合约的 TRON 派生版，三处改动各有单测（技术方案 04 页第 2 节）。
///   ① CREATE2 地址前缀 0x41：SweepBatcherTron.forwarderAddress() 按 0x41 算（以太坊版写死 0xff）
///   ② TRON USDT 的 transfer 成功也返回 false：ForwarderTron.flushTokens 按"parent 余额增加了这么多"判断成功，不看返回值
///      （返回 false 但钱到了 → 成功；返回 true 但钱没到 / 少到 → 回滚）
///   ③ TRX 系统转账不触发合约代码：去掉"收到原生币自动转给 parent"（receive / fallback），保留任何人可调用的 flush()
/// 其余保持 BitGo 原样：init 时把地址上已有的原生币转给 parent（R1：地址先被激活也能部署）、callFromParent 只有 parent 能调、
/// flushTokens 只有 parent 和 feeAddress 能调；NFT 回调删掉。批量合约其余逻辑和以太坊版相同。
/// 约定（研发实现时按这个）：src/tron/ 下三个合约；ForwarderFactoryTron(address implementation)，有 implementationAddress() 和
/// createForwarder(address parent, address feeAddress, bytes32 salt)；SweepBatcherTron 的构造参数、函数、事件、错误和 SweepBatcher 相同
/// （构造参数用 SweepBatcher.sol 里的 IForwarderFactoryV4）。
/// 这些测试在 EVM 上跑：EVM 的 CREATE2 是 0xff，所以"工厂实际部署到哪"按 0xff 算；0x41 的实际部署在本机 TRON 私链上核对（test/tron-local/）。
/// 怎么跑：cd contracts && FOUNDRY_PROFILE=tron forge test -vvv
contract ForwarderTronTest is Test {
    ForwarderTron impl;
    ForwarderFactoryTron factory;
    MockSafe safe;
    TronUsdtMock usdt;

    /// 1 个原生币（TRON 官方编译器不认 ether 单位，统一写数字）
    uint256 constant ONE = 1e18;
    address operator = makeAddr("operator");
    address attacker = makeAddr("attacker");

    event Swept(bytes32 indexed salt, address indexed forwarder, bool deployed);
    event SweepFailed(bytes32 indexed salt, address indexed forwarder, bytes reason);

    function setUp() public {
        impl = new ForwarderTron();
        factory = new ForwarderFactoryTron(address(impl));
        safe = new MockSafe(address(this));
        usdt = new TronUsdtMock();
    }

    function initHash() internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", address(impl), hex"5af43d82803e903d91602b57fd5bf3"));
    }

    function finalSalt(address parent, address fee, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parent, fee, salt));
    }

    /// EVM 上工厂实际部署出的地址（0xff）
    function evmAddr(address parent, address fee, bytes32 salt) internal view returns (address) {
        return vm.computeCreate2Address(finalSalt(parent, fee, salt), initHash(), address(factory));
    }

    /// TRON 上的地址（0x41）
    function tronAddr(address parent, address fee, bytes32 salt) internal view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0x41), address(factory), finalSalt(parent, fee, salt), initHash())))));
    }

    /// 以 address(this) 为 feeAddress 部署一个转发合约（EVM 地址）
    function deployFwd(bytes32 salt) internal returns (ForwarderTron f) {
        factory.createForwarder(address(safe), address(this), salt);
        f = ForwarderTron(payable(evmAddr(address(safe), address(this), salt)));
        assertGt(address(f).code.length, 0, "forwarder deployed");
        assertEq(f.parentAddress(), address(safe));
        assertEq(f.feeAddress(), address(this));
    }

    function one(bytes32 salt) internal pure returns (bytes32[] memory s) {
        s = new bytes32[](1);
        s[0] = salt;
    }

    // ---------- 工厂 ----------

    function test_Factory_ImplementationAndDeterministicAddress() public {
        assertEq(factory.implementationAddress(), address(impl));
        bytes32 salt = keccak256("s1");
        address want = evmAddr(address(safe), address(this), salt);
        assertEq(want.code.length, 0);
        factory.createForwarder(address(safe), address(this), salt);
        assertGt(want.code.length, 0);
        // 同一个盐不能再部署（不会覆盖已有合约）
        vm.expectRevert();
        factory.createForwarder(address(safe), address(this), salt);
    }

    function test_Forwarder_InitOnlyOnceAndRejectsZero() public {
        ForwarderTron f = deployFwd(keccak256("init"));
        // 已经初始化：任何人都不能再改 parent（直接调 init 一定失败，签名不管是哪种）
        (bool ok1,) = address(f).call(abi.encodeWithSignature("init(address,address)", attacker, attacker));
        (bool ok2,) = address(f).call(abi.encodeWithSignature("init(address,address,bool,bool)", attacker, attacker, true, true));
        assertFalse(ok1);
        assertFalse(ok2);
        assertEq(f.parentAddress(), address(safe));
        vm.expectRevert();
        factory.createForwarder(address(0), address(this), keccak256("zero-parent"));
        vm.expectRevert();
        factory.createForwarder(address(safe), address(0), keccak256("zero-fee"));
    }

    // ---------- ① 0x41 地址 ----------

    function testFuzz_Change1_BatcherForwarderAddressUses0x41(bytes32 salt) public {
        SweepBatcherTron b = new SweepBatcherTron(IForwarderFactoryV4(address(factory)), address(safe), operator);
        address got = b.forwarderAddress(salt);
        assertEq(got, tronAddr(address(safe), address(b), salt), "0x41 prefix");
        assertTrue(got != evmAddr(address(safe), address(b), salt), "not the 0xff address");
    }

    function test_Change1_ProxyInitCodeHashAndParams() public {
        SweepBatcherTron b = new SweepBatcherTron(IForwarderFactoryV4(address(factory)), address(safe), operator);
        assertEq(b.proxyInitCodeHash(), initHash());
        assertEq(address(b.factory()), address(factory));
        assertEq(b.parent(), address(safe));
    }

    /// 以太坊版不受影响：仍是 0xff（两份合约各管各的链）
    function test_Change1_EthereumBatcherStill0xff() public {
        SweepBatcher e = new SweepBatcher(IForwarderFactoryV4(address(factory)), address(safe), operator);
        bytes32 salt = keccak256("eth");
        assertEq(e.forwarderAddress(salt), evmAddr(address(safe), address(e), salt));
    }

    // ---------- ② USDT 返回 false ----------

    function test_Change2_TronUsdtReturnsFalse_FlushSucceeds() public {
        ForwarderTron f = deployFwd(keccak256("usdt"));
        usdt.mint(address(f), 1_234e6);
        f.flushTokens(address(usdt));
        assertEq(usdt.balanceOf(address(safe)), 1_234e6);
        assertEq(usdt.balanceOf(address(f)), 0);
    }

    function testFuzz_Change2_TronUsdtAnyAmount(uint96 amount) public {
        ForwarderTron f = deployFwd(keccak256("fuzz-usdt"));
        usdt.mint(address(f), amount);
        f.flushTokens(address(usdt));
        assertEq(usdt.balanceOf(address(safe)), amount);
        assertEq(usdt.balanceOf(address(f)), 0);
    }

    function test_Change2_ReturnsTrueButNothingMoved_Reverts() public {
        ForwarderTron f = deployFwd(keccak256("lying"));
        LyingToken t = new LyingToken();
        t.mint(address(f), 100e6);
        vm.expectRevert();
        f.flushTokens(address(t));
    }

    function test_Change2_ReturnsFalseAndNothingMoved_Reverts() public {
        ForwarderTron f = deployFwd(keccak256("false"));
        MockFalseToken t = new MockFalseToken();
        t.mint(address(f), 100e6);
        vm.expectRevert();
        f.flushTokens(address(t));
    }

    function test_Change2_FeeOnTransfer_Reverts() public {
        ForwarderTron f = deployFwd(keccak256("fee"));
        FeeOnTransferToken t = new FeeOnTransferToken();
        t.mint(address(f), 100e6);
        vm.expectRevert();
        f.flushTokens(address(t));
        assertEq(t.balanceOf(address(f)), 100e6, "nothing moved");
    }

    function test_Change2_StandardAndNoReturnTokensStillWork() public {
        ForwarderTron f = deployFwd(keccak256("std"));
        MockErc20 a = new MockErc20(6);
        MockUsdtNoReturn b = new MockUsdtNoReturn();
        a.mint(address(f), 5e6);
        b.mint(address(f), 7e6);
        f.flushTokens(address(a));
        f.flushTokens(address(b));
        assertEq(a.balanceOf(address(safe)), 5e6);
        assertEq(b.balanceOf(address(safe)), 7e6);
    }

    function test_Change2_RevertingTokenReverts_ZeroBalanceIsNoop() public {
        ForwarderTron f = deployFwd(keccak256("revert"));
        MockRevertToken r = new MockRevertToken();
        r.mint(address(f), 1e6);
        vm.expectRevert();
        f.flushTokens(address(r));
        f.flushTokens(address(usdt)); // 余额 0：什么都不做、不回滚
        assertEq(usdt.balanceOf(address(safe)), 0);
    }

    function test_Change2_OnlyParentOrFeeAddressCanFlushTokens() public {
        ForwarderTron f = deployFwd(keccak256("auth"));
        usdt.mint(address(f), 1e6);
        vm.prank(attacker);
        vm.expectRevert();
        f.flushTokens(address(usdt));
        vm.prank(address(safe));
        f.flushTokens(address(usdt));
        assertEq(usdt.balanceOf(address(safe)), 1e6);
    }

    /// parent 原来就有 USDT（"parent 已持有 USDT"是常态）：只核对增加的部分
    function test_Change2_ParentAlreadyHoldsUsdt() public {
        usdt.mint(address(safe), 9_999e6);
        ForwarderTron f = deployFwd(keccak256("held"));
        usdt.mint(address(f), 1e6);
        f.flushTokens(address(usdt));
        assertEq(usdt.balanceOf(address(safe)), 10_000e6);
    }

    /// 批量归集里：返回 false 的 USDT 照样 Swept；同一批里一个地址被冻结 → 只有它 SweepFailed，别的照常（部分成功）
    function test_Change2_InBatchSweep_FalseReturnSweptAndFrozenFails() public {
        SweepBatcher b = new SweepBatcher(IForwarderFactoryV4(address(factory)), address(safe), operator);
        bytes32 s1 = keccak256("b1");
        bytes32 s2 = keccak256("b2");
        address f1 = b.forwarderAddress(s1);
        address f2 = b.forwarderAddress(s2);
        usdt.mint(f1, 100e6);
        usdt.mint(f2, 200e6);
        usdt.setFrozen(f2, true);
        bytes32[] memory s = new bytes32[](2);
        s[0] = s1;
        s[1] = s2;
        vm.recordLogs();
        vm.prank(operator);
        b.sweep(address(usdt), s);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 swept;
        uint256 failed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(b)) continue;
            if (logs[i].topics[0] == Swept.selector) {
                assertEq(logs[i].topics[1], s1);
                swept++;
            }
            if (logs[i].topics[0] == SweepFailed.selector) {
                assertEq(logs[i].topics[1], s2);
                failed++;
            }
        }
        assertEq(swept, 1);
        assertEq(failed, 1);
        assertEq(usdt.balanceOf(address(safe)), 100e6);
        assertEq(usdt.balanceOf(f2), 200e6);
    }

    // ---------- ③ TRX：不自动转发，保留 flush() ----------

    /// 系统转账（TRON 的 TransferContract 不执行合约代码；EVM 上用 vm.deal 模拟）进来的钱留在地址上，任何人调 flush() 转给 parent
    function test_Change3_SystemTransferThenAnyoneFlushes() public {
        ForwarderTron f = deployFwd(keccak256("trx"));
        vm.deal(address(f), 5 * ONE);
        uint256 before = address(safe).balance;
        vm.prank(attacker);
        f.flush();
        assertEq(address(safe).balance - before, 5 * ONE);
        assertEq(address(f).balance, 0);
        f.flush(); // 余额 0：什么都不做
    }

    /// 去掉了"收到原生币自动转给 parent"：直接带钱调用（没有数据、或不认识的函数）不会把钱转给 parent
    function test_Change3_NoAutoForwardOnPlainValueCall() public {
        ForwarderTron f = deployFwd(keccak256("plain"));
        vm.deal(address(this), 3 * ONE);
        uint256 before = address(safe).balance;
        (bool ok1,) = address(f).call{value: 1 * ONE}("");
        (bool ok2,) = address(f).call{value: 1 * ONE}(abi.encodeWithSignature("nonexistent()"));
        ok1;
        ok2;
        assertEq(address(safe).balance, before, "no auto-forward to parent");
    }

    /// R1：地址在部署前先收到了原生币（被激活）：init 时转给 parent（保留 BitGo 原样）
    function test_Change3_PreFundedAddressForwardsOnInit() public {
        bytes32 salt = keccak256("prefunded");
        address want = evmAddr(address(safe), address(this), salt);
        vm.deal(want, 1 * ONE);
        usdt.mint(want, 50e6);
        uint256 before = address(safe).balance;
        factory.createForwarder(address(safe), address(this), salt);
        assertEq(address(safe).balance - before, 1 * ONE);
        assertEq(want.balance, 0);
        ForwarderTron(payable(want)).flushTokens(address(usdt));
        assertEq(usdt.balanceOf(address(safe)), 50e6);
    }

    // ---------- 其余：NFT 回调删掉、callFromParent 只有 parent ----------

    function test_NoNftCallbacks() public {
        ForwarderTron f = deployFwd(keccak256("nft"));
        (bool ok721,) = address(f).call(abi.encodeWithSignature("onERC721Received(address,address,uint256,bytes)", address(0), address(0), 1, ""));
        (bool ok1155,) = address(f).call(abi.encodeWithSignature("onERC1155Received(address,address,uint256,uint256,bytes)", address(0), address(0), 1, 1, ""));
        (bool okBatch,) = address(f).call(abi.encodeWithSignature("onERC1155BatchReceived(address,address,uint256[],uint256[],bytes)", address(0), address(0), new uint256[](0), new uint256[](0), ""));
        assertFalse(ok721);
        assertFalse(ok1155);
        assertFalse(okBatch);
    }

    function test_CallFromParentOnlyParent() public {
        ForwarderTron f = deployFwd(keccak256("cfp"));
        usdt.mint(address(f), 10e6);
        bytes memory data = abi.encodeWithSignature("setFrozen(address,bool)", attacker, true);
        vm.prank(attacker);
        vm.expectRevert();
        f.callFromParent(address(usdt), 0, data);
        vm.prank(address(safe));
        f.callFromParent(address(usdt), 0, data);
        assertTrue(usdt.frozen(attacker));
    }

    // ---------- 批量合约其余和以太坊版相同 ----------

    function test_Batcher_OnlyOperatorOwnerRules() public {
        SweepBatcherTron b = new SweepBatcherTron(IForwarderFactoryV4(address(factory)), address(safe), operator);
        assertTrue(b.isOperator(operator));
        vm.prank(attacker);
        vm.expectRevert(SweepBatcherTron.NotOperator.selector);
        b.sweep(address(usdt), one(keccak256("x")));
        vm.prank(attacker);
        vm.expectRevert();
        b.setOperator(attacker, true);
        vm.expectRevert(SweepBatcherTron.RenounceDisabled.selector);
        b.renounceOwnership();
        vm.expectRevert(SweepBatcherTron.ZeroAddress.selector);
        new SweepBatcherTron(IForwarderFactoryV4(address(factory)), address(0), operator);
        // 两步转移所有权
        b.transferOwnership(address(safe));
        assertEq(b.owner(), address(this));
        vm.prank(address(safe));
        b.acceptOwnership();
        assertEq(b.owner(), address(safe));
    }

    /// 批量合约本身不收钱：直接给它转原生币失败
    function test_Batcher_HoldsNothing() public {
        SweepBatcherTron b = new SweepBatcherTron(IForwarderFactoryV4(address(factory)), address(safe), operator);
        vm.deal(address(this), 1 * ONE);
        (bool ok,) = address(b).call{value: 1 * ONE}("");
        assertFalse(ok);
        assertEq(address(b).balance, 0);
    }
}
