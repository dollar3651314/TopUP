// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

// 测试先写（第 3 批）：批量打款合约 BatchPayout（以太坊、BSC）。依据技术方案 05 页第 1 节和第 5 节：
//   - 不持有钱：没有 payable / receive / fallback，没有unicode"把合约里的钱转走"的函数；钱从调用者（热钱包）的授权额度 transferFrom 直接到收款人，不经过本合约
//   - 只有 owner（冷钱包多签）登记的热钱包（payer）能调用 pay；owner 两步转移（Ownable2Step）、禁止放弃
//   - 一批里一笔失败整批回滚（Q15）；返回 false、不返回 bool（以太坊 USDT）都要处理对（BitGo TransferHelper 的写法）
//   - MAX_ITEMS = 100；to 和 amount 长度要相等；空批不收
// 期望的合约（src/BatchPayout.sol，solc 0.8.20，和 SweepBatcher 同一套编译参数）：
//   contract BatchPayout is Ownable2Step {
//     uint256 public constant MAX_ITEMS = 100;
//     mapping(address => bool) public isPayer;
//     event PayerSet(address indexed payer, bool allowed);
//     event Paid(bytes32 indexed batchId, address indexed to, uint256 amount);
//     error NotPayer(); error LengthMismatch(); error TooManyItems(); error EmptyBatch(); error ZeroAddress(); error RenounceDisabled();
//     constructor(address payer_)            // owner = 部署账户，随后两步转给 Safe；payer_ 不能是 0
//     function setPayer(address payer, bool allowed) external onlyOwner;   // payer 不能是 0
//     function pay(address token, bytes32 batchId, address[] calldata to, uint256[] calldata amount) external;  // 收款人不能是 0（ZeroAddress）
//     function renounceOwnership() public view override onlyOwner { revert RenounceDisabled(); }
//   }
// 金额为 0 的笔不特别处理（交给代币）；收手续费的代币不做余额前后核对（05 页unicode"余额核对"一行定的），这里的用例把这个行为写清楚。

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BatchPayout} from "../src/BatchPayout.sol";
import {MockUsdtTF, MockErc20TF, MockFalseTF, MockRevertTF, MockFeeTF} from "./PayoutMocks.sol";
import {MockSafe} from "../test/Mocks.sol";

contract BatchPayoutTest is Test {
    BatchPayout internal bp;
    MockUsdtTF internal usdt;
    MockErc20TF internal usdt18;
    MockSafe internal safe;
    address internal hot = makeAddr("hot");
    address internal hot2 = makeAddr("hot2");
    address internal stranger = makeAddr("stranger");
    bytes32 internal constant BATCH = keccak256("PB-1");

    event Paid(bytes32 indexed batchId, address indexed to, uint256 amount);
    event PayerSet(address indexed payer, bool allowed);

    function setUp() public {
        bp = new BatchPayout(hot);
        safe = new MockSafe(address(this));
        bp.transferOwnership(address(safe));
        safe.exec(address(bp), abi.encodeCall(bp.acceptOwnership, ()));
        usdt = new MockUsdtTF();
        usdt18 = new MockErc20TF(18);
        usdt.mint(hot, 1_000_000e6);
        usdt18.mint(hot, 1_000_000e18);
        vm.startPrank(hot);
        usdt.approve(address(bp), 10_000e6);
        usdt18.approve(address(bp), 10_000e18);
        vm.stopPrank();
    }

    function _list(uint256 n, uint256 each) internal returns (address[] memory to, uint256[] memory amt) {
        to = new address[](n);
        amt = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            to[i] = makeAddr(string(abi.encodePacked("r", vm.toString(i))));
            amt[i] = each + i;
        }
    }

    // ---------- 权限 ----------
    function test_constructor_registersPayer_andRejectsZero() public {
        assertTrue(bp.isPayer(hot));
        assertFalse(bp.isPayer(stranger));
        assertEq(bp.owner(), address(safe));
        assertEq(bp.MAX_ITEMS(), 100);
        vm.expectRevert(BatchPayout.ZeroAddress.selector);
        new BatchPayout(address(0));
    }

    function test_onlyPayer_canPay() public {
        (address[] memory to, uint256[] memory amt) = _list(2, 1e6);
        vm.prank(stranger);
        vm.expectRevert(BatchPayout.NotPayer.selector);
        bp.pay(address(usdt), BATCH, to, amt);
        // owner（Safe）本身也不能付
        vm.prank(address(safe));
        vm.expectRevert(BatchPayout.NotPayer.selector);
        bp.pay(address(usdt), BATCH, to, amt);
    }

    function test_setPayer_onlyOwner_emits_andRevokes() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        bp.setPayer(stranger, true);
        vm.expectEmit(true, false, false, true, address(bp));
        emit PayerSet(hot2, true);
        safe.exec(address(bp), abi.encodeCall(bp.setPayer, (hot2, true)));
        assertTrue(bp.isPayer(hot2));
        // 换热钱包：撤销旧的
        safe.exec(address(bp), abi.encodeCall(bp.setPayer, (hot, false)));
        (address[] memory to, uint256[] memory amt) = _list(1, 1e6);
        vm.prank(hot);
        vm.expectRevert(BatchPayout.NotPayer.selector);
        bp.pay(address(usdt), BATCH, to, amt);
        vm.expectRevert();
        safe.exec(address(bp), abi.encodeCall(bp.setPayer, (address(0), true)));
    }

    function test_ownership_twoStep_andRenounceDisabled() public {
        address next = makeAddr("next");
        safe.exec(address(bp), abi.encodeCall(bp.transferOwnership, (next)));
        assertEq(bp.owner(), address(safe), unicode"两步：接受之前还是旧 owner");
        vm.prank(next);
        bp.acceptOwnership();
        assertEq(bp.owner(), next);
        vm.prank(next);
        vm.expectRevert(BatchPayout.RenounceDisabled.selector);
        bp.renounceOwnership();
        assertEq(bp.owner(), next);
    }

    // ---------- 打款 ----------
    function test_pay_transfersFromCaller_toEach_emitsPaid_contractHoldsNothing() public {
        (address[] memory to, uint256[] memory amt) = _list(3, 5e6);
        for (uint256 i; i < 3; ++i) {
            vm.expectEmit(true, true, false, true, address(bp));
            emit Paid(BATCH, to[i], amt[i]);
        }
        uint256 before = usdt.balanceOf(hot);
        vm.prank(hot);
        bp.pay(address(usdt), BATCH, to, amt);
        uint256 sum;
        for (uint256 i; i < 3; ++i) {
            assertEq(usdt.balanceOf(to[i]), amt[i]);
            sum += amt[i];
        }
        assertEq(before - usdt.balanceOf(hot), sum, unicode"热钱包减少 = 输入之和");
        assertEq(usdt.balanceOf(address(bp)), 0, unicode"钱不经过合约");
        assertEq(usdt.allowance(hot, address(bp)), 10_000e6 - sum, unicode"只用掉调用者自己的额度");
    }

    function test_pay_bsc18Decimals() public {
        address[] memory to = new address[](1);
        uint256[] memory amt = new uint256[](1);
        to[0] = makeAddr("r");
        amt[0] = 12.5e18;
        vm.prank(hot);
        bp.pay(address(usdt18), BATCH, to, amt);
        assertEq(usdt18.balanceOf(to[0]), 12.5e18);
    }

    function test_oneFails_wholeBatchReverts() public {
        (address[] memory to, uint256[] memory amt) = _list(5, 1e6);
        usdt.block_(to[3], true); // 第 4 笔收款人被代币拉黑
        uint256 before = usdt.balanceOf(hot);
        vm.prank(hot);
        vm.expectRevert();
        bp.pay(address(usdt), BATCH, to, amt);
        assertEq(usdt.balanceOf(hot), before, unicode"整批回滚：一分没动");
        for (uint256 i; i < 5; ++i) assertEq(usdt.balanceOf(to[i]), 0);
        assertEq(usdt.allowance(hot, address(bp)), 10_000e6, unicode"额度也没动");
    }

    function test_overAllowance_wholeBatchReverts() public {
        (address[] memory to, uint256[] memory amt) = _list(2, 6_000e6); // 合计 12,000 > 额度 10,000
        vm.prank(hot);
        vm.expectRevert();
        bp.pay(address(usdt), BATCH, to, amt);
        assertEq(usdt.balanceOf(to[0]), 0);
    }

    function test_tokenReturnsFalse_reverts() public {
        MockFalseTF f = new MockFalseTF();
        f.mint(hot, 100e6);
        vm.prank(hot);
        f.approve(address(bp), 100e6);
        (address[] memory to, uint256[] memory amt) = _list(1, 1e6);
        vm.prank(hot);
        vm.expectRevert();
        bp.pay(address(f), BATCH, to, amt);
    }

    function test_tokenReverts_reverts_andNonContractToken_reverts() public {
        MockRevertTF r = new MockRevertTF();
        (address[] memory to, uint256[] memory amt) = _list(1, 1e6);
        vm.startPrank(hot);
        vm.expectRevert();
        bp.pay(address(r), BATCH, to, amt);
        // 代币地址没有代码（填错地址）：不能当成功
        vm.expectRevert();
        bp.pay(makeAddr("eoa"), BATCH, to, amt);
        vm.stopPrank();
    }

    function test_lengthMismatch_empty_tooMany_zeroRecipient() public {
        (address[] memory to, uint256[] memory amt) = _list(3, 1e6);
        uint256[] memory two = new uint256[](2);
        vm.startPrank(hot);
        vm.expectRevert(BatchPayout.LengthMismatch.selector);
        bp.pay(address(usdt), BATCH, to, two);
        vm.expectRevert(BatchPayout.EmptyBatch.selector);
        bp.pay(address(usdt), BATCH, new address[](0), new uint256[](0));
        (address[] memory to100, uint256[] memory a100) = _list(100, 1);
        bp.pay(address(usdt), BATCH, to100, a100); // 正好 100 笔可以
        (address[] memory to101, uint256[] memory a101) = _list(101, 1);
        vm.expectRevert(BatchPayout.TooManyItems.selector);
        bp.pay(address(usdt), BATCH, to101, a101);
        to[1] = address(0);
        vm.expectRevert(BatchPayout.ZeroAddress.selector);
        bp.pay(address(usdt), BATCH, to, amt);
        vm.stopPrank();
    }

    function test_holdsNoMoney_noReceive_noFallback() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(bp).call{value: 1 wei}("");
        assertFalse(ok, unicode"不收原生币");
        vm.prank(stranger);
        (ok,) = address(bp).call{value: 1 wei}(hex"12345678");
        assertFalse(ok, unicode"没有 fallback");
        assertEq(address(bp).balance, 0);
        // pay 不是 payable
        (address[] memory to, uint256[] memory amt) = _list(1, 1e6);
        vm.deal(hot, 1 ether);
        vm.prank(hot);
        (ok,) = address(bp).call{value: 1}(abi.encodeCall(bp.pay, (address(usdt), BATCH, to, amt)));
        assertFalse(ok, unicode"pay 不收原生币");
    }

    function test_paySelector_isWhatTheSigningPageDecodes() public view {
        // 签名页面（server/wallet/evm-payout-codec.js）按这个函数签名解码；外部函数的完整名单在 test/anvil/payout-anvil.test.js 用编译产物核对
        assertEq(bytes4(keccak256("pay(address,bytes32,address[],uint256[])")), bp.pay.selector);
    }

    function test_ethUsdt_allowanceMustResetToZeroFirst() public {
        // 以太坊 USDT：非 0 改非 0 直接回滚；先归零再设（两笔），之后照常打款
        vm.startPrank(hot);
        vm.expectRevert();
        usdt.approve(address(bp), 20_000e6);
        usdt.approve(address(bp), 0);
        usdt.approve(address(bp), 20_000e6);
        vm.stopPrank();
        (address[] memory to, uint256[] memory amt) = _list(2, 6_000e6);
        vm.prank(hot);
        bp.pay(address(usdt), BATCH, to, amt);
        assertEq(usdt.allowance(hot, address(bp)), 20_000e6 - 12_000e6 - 1);
    }

    function test_feeToken_noBalanceCheck_documented() public {
        MockFeeTF f = new MockFeeTF();
        f.mint(hot, 1_000e6);
        vm.prank(hot);
        f.approve(address(bp), 1_000e6);
        address[] memory to = new address[](1);
        uint256[] memory amt = new uint256[](1);
        to[0] = makeAddr("r");
        amt[0] = 100e6;
        vm.prank(hot);
        bp.pay(address(f), BATCH, to, amt);
        assertEq(f.balanceOf(hot), 900e6, unicode"热钱包减少 = 输入");
        assertEq(f.balanceOf(to[0]), 99e6, unicode"代币扣的费由收款人承担；合约不核对（05 页定的），后端只用 USDT");
        assertEq(f.balanceOf(address(bp)), 0);
    }

    // ---------- 模糊（每个 ≥ 10,000 次，foundry.toml） ----------
    function testFuzz_pay_conservation(uint8 nRaw, uint256 seed, bool use18) public {
        uint256 n = bound(nRaw, 1, 100);
        address token = use18 ? address(usdt18) : address(usdt);
        uint256 unit = use18 ? 1e18 : 1e6;
        address[] memory to = new address[](n);
        uint256[] memory amt = new uint256[](n);
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            to[i] = address(uint160(uint256(keccak256(abi.encode(seed, i))) | 1));
            amt[i] = bound(uint256(keccak256(abi.encode(seed, i, "a"))), 0, 200 * unit);
            sum += amt[i];
        }
        uint256 before = use18 ? usdt18.balanceOf(hot) : usdt.balanceOf(hot);
        uint256[] memory rb = new uint256[](n);
        for (uint256 i; i < n; ++i) rb[i] = use18 ? usdt18.balanceOf(to[i]) : usdt.balanceOf(to[i]);
        vm.prank(hot);
        if (sum > 10_000 * unit) {
            vm.expectRevert();
            bp.pay(token, BATCH, to, amt);
            assertEq(use18 ? usdt18.balanceOf(hot) : usdt.balanceOf(hot), before);
            return;
        }
        bp.pay(token, BATCH, to, amt);
        uint256 after_ = use18 ? usdt18.balanceOf(hot) : usdt.balanceOf(hot);
        assertEq(before - after_, sum);
        // 收款人由种子哈希得出，不会重复：每个人正好多了自己那一笔
        for (uint256 i; i < n; ++i) assertEq((use18 ? usdt18.balanceOf(to[i]) : usdt.balanceOf(to[i])) - rb[i], amt[i]);
        assertEq(use18 ? usdt18.balanceOf(address(bp)) : usdt.balanceOf(address(bp)), 0);
    }

    function testFuzz_strangerNeverPays(address who, uint8 nRaw) public {
        vm.assume(!bp.isPayer(who));
        uint256 n = bound(nRaw, 1, 100);
        (address[] memory to, uint256[] memory amt) = _list(n, 1);
        vm.prank(who);
        vm.expectRevert(BatchPayout.NotPayer.selector);
        bp.pay(address(usdt), BATCH, to, amt);
    }

    function testFuzz_onePoisonedItem_revertsAll(uint8 nRaw, uint8 badRaw) public {
        uint256 n = bound(nRaw, 1, 100);
        uint256 bad = bound(badRaw, 0, n - 1);
        (address[] memory to, uint256[] memory amt) = _list(n, 1e6);
        usdt.block_(to[bad], true);
        uint256 before = usdt.balanceOf(hot);
        vm.prank(hot);
        vm.expectRevert();
        bp.pay(address(usdt), BATCH, to, amt);
        assertEq(usdt.balanceOf(hot), before);
        assertEq(usdt.balanceOf(to[0 == bad ? n - 1 : 0]), 0);
    }

    function testFuzz_lengthMismatch(uint8 a, uint8 b) public {
        uint256 na = bound(a, 1, 100);
        uint256 nb = bound(b, 1, 100);
        vm.assume(na != nb);
        (address[] memory to,) = _list(na, 1);
        uint256[] memory amt = new uint256[](nb);
        vm.prank(hot);
        vm.expectRevert(BatchPayout.LengthMismatch.selector);
        bp.pay(address(usdt), BATCH, to, amt);
    }
}
