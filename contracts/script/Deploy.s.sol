// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

import {console} from "forge-std/Script.sol";
import {ForwarderV4} from "bitgo/ForwarderV4.sol";
import {ForwarderFactoryV4} from "bitgo/ForwarderFactoryV4.sol";
import {SweepBatcher, IForwarderFactoryV4} from "../src/SweepBatcher.sol";
import {SweepCheck} from "./SweepCheck.sol";

/// 部署资金归集合约。由管理员在自己的电脑上用部署账户运行，私钥不写进任何文件：
///   forge script script/Deploy.s.sol --rpc-url <节点> --sender <部署账户地址> --interactives 1 --broadcast
///   （或者硬件钱包：把 --interactives 1 换成 --ledger）
/// 参数（环境变量，都是公开地址）：
///   SWEEP_PARENT          冷钱包 = Safe 多签地址（以太坊、BSC 必须是同一个地址）
///   SWEEP_OPERATOR        发起账户（服务器上的 EOA）地址
///   SWEEP_OWNER           批量合约的所有者，默认等于 SWEEP_PARENT（Safe）
///   SWEEP_EXPECT_NONCE    部署账户当前的 nonce 必须等于它（默认 0）：以太坊和 BSC 用同一个 nonce 顺序部署，合约地址才相同
/// 顺序：nonce N 实现合约 → N+1 工厂 → N+2 批量合约 → N+3 批量合约 transferOwnership(SWEEP_OWNER)。
/// 部署完在模拟里核对一遍（SweepCheck），打印要填进服务器 .env 的地址；Safe 还要签一笔 acceptOwnership。
contract Deploy is SweepCheck {
    function run() external {
        address parent = vm.envAddress("SWEEP_PARENT");
        address operator = vm.envAddress("SWEEP_OPERATOR");
        address owner = vm.envOr("SWEEP_OWNER", parent);
        uint256 expectNonce = vm.envOr("SWEEP_EXPECT_NONCE", uint256(0));
        uint256 id = block.chainid;
        require(id == 1 || id == 56 || id == 11155111 || id == 97 || id == 31337, unicode"只支持以太坊主网 1、BSC 56、Sepolia 11155111、BSC 测试网 97、本地 anvil 31337");
        address deployer = msg.sender;
        uint64 nonce = vm.getNonce(deployer);
        console.log(unicode"链 ID:", id);
        console.log(unicode"部署账户:", deployer, unicode"nonce:", nonce);
        require(nonce == expectNonce, unicode"部署账户的 nonce 不是 SWEEP_EXPECT_NONCE：两条链 nonce 不同，部署出的地址会不同（用一个新的部署账户，或者设 SWEEP_EXPECT_NONCE）");
        // 主网的冷钱包必须是已经部署好的 Safe；测试网（Safe 不支持的测试网可以先用普通地址演练）和本地 anvil 只提示
        bool mainnet = id == 1 || id == 56;
        require(parent.code.length > 0 || !mainnet, unicode"SWEEP_PARENT 不是合约：主网的冷钱包必须是已经部署好的 Safe");
        if (parent.code.length == 0) console.log(unicode"提示：SWEEP_PARENT 不是合约（测试网演练可以，主网不行）");
        require(deployer.balance > 0, unicode"部署账户没有手续费币");

        vm.startBroadcast();
        ForwarderV4 impl = new ForwarderV4();
        ForwarderFactoryV4 factory = new ForwarderFactoryV4(address(impl));
        SweepBatcher batcher = new SweepBatcher(IForwarderFactoryV4(address(factory)), parent, operator);
        batcher.transferOwnership(owner);
        vm.stopBroadcast();

        Deployed memory d = Deployed(address(impl), address(factory), address(batcher), parent, operator, owner);
        check(d);
        printEnv(d);
        console.log(unicode"下一步：在区块浏览器验证源码，Safe 签 acceptOwnership，然后在另一条链上用同一个部署账户再跑一遍。");
    }
}
