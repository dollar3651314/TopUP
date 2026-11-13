// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {ForwarderV4} from "bitgo/ForwarderV4.sol";
import {ForwarderFactoryV4} from "bitgo/ForwarderFactoryV4.sol";
import {SweepBatcher, IForwarderFactoryV4} from "../src/SweepBatcher.sol";
import {DepositSalt} from "../src/DepositSalt.sol";

/// 部署后核对（Deploy.s.sol 部署完在模拟里先跑一遍；VerifyDeployment.s.sol 连链上再跑一遍）。
abstract contract SweepCheck is Script {
    struct Deployed {
        address implementation;
        address factory;
        address batcher;
        address parent;
        address operator;
        address owner;
    }

    uint256 internal failures;

    function ok(bool cond, string memory what) internal {
        if (cond) {
            console.log(unicode"  [通过]", what);
        } else {
            failures++;
            console.log(unicode"  [失败]", what);
        }
    }

    /// 去掉 solc 追加在运行时字节码末尾的 CBOR 元数据（最后 2 字节是它的长度）
    function stripMetadata(bytes memory code) internal pure returns (bytes memory out) {
        if (code.length < 2) return code;
        uint256 len = (uint256(uint8(code[code.length - 2])) << 8) | uint256(uint8(code[code.length - 1]));
        if (len + 2 > code.length) return code;
        out = new bytes(code.length - len - 2);
        for (uint256 i; i < out.length; ++i) out[i] = code[i];
    }

    function check(Deployed memory d) internal {
        console.log(unicode"== 核对（链 ID", block.chainid, ")");
        // 1. 字节码：实现合约和本仓库按同样的参数编译的结果逐字节一致；工厂、批量合约（含 immutable）和在本地按同样参数重新部署的一份一致
        ok(keccak256(d.implementation.code) == keccak256(vm.getDeployedCode("ForwarderV4.sol:ForwarderV4")),
            unicode"ForwarderV4 实现合约的字节码 = 本仓库 lib/eth-multisig-v4 原样编译的结果");
        ForwarderFactoryV4 refFactory = new ForwarderFactoryV4(d.implementation);
        ok(keccak256(d.factory.code) == keccak256(address(refFactory).code), unicode"ForwarderFactoryV4 工厂的字节码 = 原样编译 + 同一个实现合约地址");
        SweepBatcher refBatcher = new SweepBatcher(IForwarderFactoryV4(d.factory), d.parent, d.operator);
        ok(keccak256(d.batcher.code) == keccak256(address(refBatcher).code), unicode"SweepBatcher 批量合约的字节码 = 本仓库编译 + 同样的工厂和 parent");
        console.log(unicode"  实现合约运行时字节码哈希（去掉元数据，和 BitGo 官方部署比对用）:");
        console.logBytes32(keccak256(stripMetadata(d.implementation.code)));
        // 2. 参数
        ok(ForwarderFactoryV4(d.factory).implementationAddress() == d.implementation, unicode"工厂的实现合约地址");
        SweepBatcher b = SweepBatcher(d.batcher);
        ok(address(b.factory()) == d.factory, unicode"批量合约的工厂地址");
        ok(b.parent() == d.parent, unicode"批量合约的 parent = 冷钱包");
        ok(b.isOperator(d.operator), unicode"发起账户已登记");
        bool owned = b.owner() == d.owner;
        bool pending = b.pendingOwner() == d.owner;
        ok(owned || pending, unicode"批量合约的所有者是 Safe（或者正在等 Safe 接受）");
        if (pending && !owned) console.log(unicode"  提示：Safe 还没有接受所有权（acceptOwnership）");
        // 主网的 parent 必须是合约（Safe）；测试网和本地 anvil 演练时可以是普通地址
        if (block.chainid == 1 || block.chainid == 56) {
            ok(d.parent.code.length > 0, unicode"parent 是合约（Safe 多签），不是普通地址");
        } else if (d.parent.code.length == 0) {
            console.log(unicode"  提示：parent 不是合约（测试网演练可以，主网不行）");
        }
        ok(d.parent != d.operator && d.parent != d.batcher && d.parent != d.factory, unicode"parent 不是发起账户、批量合约或工厂");
        // 3. 地址算法：用户 1 的充值地址
        address user1 = b.forwarderAddress(DepositSalt.forCustomer(1));
        console.log(unicode"  用户 1 的充值地址（和后台 / 测试向量核对）:", user1);
        if (user1.code.length > 0) {
            ok(ForwarderV4(payable(user1)).parentAddress() == d.parent, unicode"用户 1 的转发合约 parent");
        }
        if (failures == 0) {
            console.log(unicode"== 全部通过");
        } else {
            console.log(unicode"== 有失败项：", failures);
            revert(unicode"核对没有通过，不要把地址填进服务器");
        }
    }

    function printEnv(Deployed memory d) internal pure {
        console.log(unicode"== 服务器 .env（都是公开地址，不是密钥；ERC20 和 BSC 共用同一组）");
        console.log("FX_SWEEP_EVM_FACTORY=", d.factory);
        console.log("FX_SWEEP_EVM_IMPLEMENTATION=", d.implementation);
        console.log("FX_SWEEP_EVM_BATCHER=", d.batcher);
        console.log("FX_SWEEP_EVM_PARENT=", d.parent);
        console.log("FX_SWEEP_EVM_OPERATOR_ADDRESS=", d.operator);
    }
}
