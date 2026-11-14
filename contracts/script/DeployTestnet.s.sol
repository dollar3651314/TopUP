// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

import {console} from "forge-std/Script.sol";
import {ForwarderV4} from "bitgo/ForwarderV4.sol";
import {ForwarderFactoryV4} from "bitgo/ForwarderFactoryV4.sol";
import {SweepBatcher, IForwarderFactoryV4} from "../src/SweepBatcher.sol";
import {SweepCheck} from "./SweepCheck.sol";
import {TestUSDT} from "./testnet/TestUSDT.sol";

/// 测试网部署（Sepolia、BSC 测试网；本地 anvil 演练）。由 scripts/testnet/deploy.mjs 调用（GitHub 的 testnet-deploy 流程），不要直接用在主网：
/// 主网链 ID 直接拒绝，主网用 Deploy.s.sol（管理员在自己电脑上、硬件钱包签名）。
/// 和 Deploy.s.sol 的顺序一样：nonce N 实现合约 → N+1 工厂 → N+2 批量合约 → N+3 批量合约 transferOwnership(owner)；
/// 之后（可选）N+4 测试 USDT（部署时直接 mint 给 TESTNET_USDT_TO）→ BatchPayout → BatchPayout transferOwnership(owner)。
/// 两条链用同一个部署账户、同一个起始 nonce、同样的参数，地址就相同。
/// 参数（环境变量）：
///   TOPUP_TESTNET_DEPLOYER_KEY  部署账户私钥（只从环境变量读，不进命令行参数、不打印）
///   SWEEP_PARENT / SWEEP_OPERATOR / SWEEP_OWNER（默认 = parent）/ SWEEP_EXPECT_NONCE（默认 0）：同 Deploy.s.sol
///   TESTNET_USDT                1 = 部署测试 USDT（默认 0）；TESTNET_USDT_TO（默认部署账户）、TESTNET_USDT_MINT（整数个，默认 1,000,000）；
///                               小数位数按链定：Sepolia 6、BSC 测试网 18（和主网 USDT 一样，后端按链换算）；本地 anvil 用 TESTNET_USDT_DECIMALS（默认 6）
///   PAYOUT_PAYER                批量打款的热钱包地址；设了才部署 BatchPayout（第 3 批的合约，src/BatchPayout.sol 合并进来之后才有）
/// 结果：每个地址一行 "TOPUP_OUT 名字 地址"（deploy.mjs 读这些行），都是公开地址。
contract DeployTestnet is SweepCheck {
    struct Params {
        uint256 key;
        address deployer;
        address parent;
        address operator;
        address owner;
        uint256 expectNonce;
        bool usdt;
        address usdtTo;
        uint256 usdtMint;
        uint8 usdtDecimals;
        address payer;
    }

    function params() internal view returns (Params memory p) {
        uint256 id = block.chainid;
        p.key = vm.envUint("TOPUP_TESTNET_DEPLOYER_KEY");
        p.deployer = vm.addr(p.key);
        p.parent = vm.envAddress("SWEEP_PARENT");
        p.operator = vm.envAddress("SWEEP_OPERATOR");
        p.owner = vm.envOr("SWEEP_OWNER", p.parent);
        p.expectNonce = vm.envOr("SWEEP_EXPECT_NONCE", uint256(0));
        p.usdt = vm.envOr("TESTNET_USDT", uint256(0)) == 1;
        p.usdtTo = vm.envOr("TESTNET_USDT_TO", p.deployer);
        p.usdtMint = vm.envOr("TESTNET_USDT_MINT", uint256(1_000_000));
        p.usdtDecimals = id == 97 ? 18 : id == 11155111 ? 6 : uint8(vm.envOr("TESTNET_USDT_DECIMALS", uint256(6)));
        p.payer = vm.envOr("PAYOUT_PAYER", address(0));
    }

    function run() external {
        uint256 id = block.chainid;
        require(id == 11155111 || id == 97 || id == 31337, unicode"测试网部署只支持 Sepolia 11155111、BSC 测试网 97、本地 anvil 31337（主网用 Deploy.s.sol）");
        Params memory p = params();
        uint64 nonce = vm.getNonce(p.deployer);
        console.log(unicode"链 ID:", id);
        console.log(unicode"部署账户:", p.deployer, unicode"nonce:", nonce);
        require(nonce == p.expectNonce, unicode"部署账户的 nonce 不是 SWEEP_EXPECT_NONCE：两条链 nonce 不同，部署出的地址会不同（用一个新的部署账户，或者在运行时填起始 nonce）");
        require(p.deployer.balance > 0, unicode"部署账户没有手续费币（先去水龙头领）");
        require(p.parent != address(0) && p.operator != address(0), unicode"parent、发起账户不能是 0 地址");
        require(p.parent != p.deployer, unicode"parent（冷钱包）不要用部署账户：部署账户的私钥在 GitHub 里");
        if (p.parent.code.length == 0) console.log(unicode"提示：SWEEP_PARENT 不是合约（测试网演练可以，主网必须是 Safe）");

        vm.startBroadcast(p.key);
        ForwarderV4 impl = new ForwarderV4();
        ForwarderFactoryV4 factory = new ForwarderFactoryV4(address(impl));
        SweepBatcher batcher = new SweepBatcher(IForwarderFactoryV4(address(factory)), p.parent, p.operator);
        batcher.transferOwnership(p.owner);
        address token = p.usdt ? address(new TestUSDT(p.usdtDecimals, false, p.usdtTo, p.usdtMint)) : address(0);
        address payout = p.payer != address(0) ? deployPayout(p) : address(0);
        vm.stopBroadcast();

        check(Deployed(address(impl), address(factory), address(batcher), p.parent, p.operator, p.owner));
        if (payout != address(0)) checkPayout(payout, p);
        console.log("TOPUP_OUT chainId", id);
        console.log("TOPUP_OUT deployer", p.deployer);
        console.log("TOPUP_OUT startNonce", nonce);
        console.log("TOPUP_OUT implementation", address(impl));
        console.log("TOPUP_OUT factory", address(factory));
        console.log("TOPUP_OUT batcher", address(batcher));
        console.log("TOPUP_OUT parent", p.parent);
        console.log("TOPUP_OUT operator", p.operator);
        console.log("TOPUP_OUT owner", p.owner);
        if (token != address(0)) console.log("TOPUP_OUT usdt", token);
        if (payout != address(0)) {
            console.log("TOPUP_OUT payout", payout);
            console.log("TOPUP_OUT hot", p.payer);
        }
    }

    /// 用编译产物部署 BatchPayout（不 import）：src/BatchPayout.sol 还没合并进来时本脚本照样能编译；没有产物时 getCode 报错
    function deployPayout(Params memory p) internal returns (address payout) {
        bytes memory code = abi.encodePacked(vm.getCode("BatchPayout.sol:BatchPayout"), abi.encode(p.payer));
        assembly {
            payout := create(0, add(code, 0x20), mload(code))
        }
        require(payout != address(0), unicode"BatchPayout 部署失败");
        (bool ok,) = payout.call(abi.encodeWithSignature("transferOwnership(address)", p.owner));
        require(ok, unicode"BatchPayout transferOwnership 失败");
    }

    function checkPayout(address payout, Params memory p) internal view {
        (bool ok, bytes memory r) = payout.staticcall(abi.encodeWithSignature("isPayer(address)", p.payer));
        require(ok && r.length == 32 && abi.decode(r, (bool)), unicode"BatchPayout 的热钱包没有登记");
        (ok, r) = payout.staticcall(abi.encodeWithSignature("pendingOwner()"));
        require(ok && r.length == 32 && abi.decode(r, (address)) == p.owner, unicode"BatchPayout 的所有者没有交给 owner");
        console.log(unicode"  [通过] BatchPayout：热钱包已登记，所有者等 owner 接受");
    }
}
