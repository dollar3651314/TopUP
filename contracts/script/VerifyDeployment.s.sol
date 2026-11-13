// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

import {console} from "forge-std/Script.sol";
import {SweepCheck} from "./SweepCheck.sol";

/// 连链上核对已部署的合约（只读，不发交易、不需要私钥）：
///   SWEEP_FACTORY=0x… SWEEP_IMPLEMENTATION=0x… SWEEP_BATCHER=0x… SWEEP_PARENT=0x… SWEEP_OPERATOR=0x… \
///   forge script script/VerifyDeployment.s.sol --rpc-url <节点>
/// 可选：SWEEP_OWNER（默认 SWEEP_PARENT）；BITGO_REFERENCE_FORWARDER = BitGo 官方在这条链上部署的 ForwarderV4 实现合约地址
/// （能在区块浏览器找到时填），会比较两边去掉元数据后的字节码。
/// 以太坊和 BSC 各跑一次，结果写进部署记录。
contract VerifyDeployment is SweepCheck {
    function run() external {
        Deployed memory d = Deployed(
            vm.envAddress("SWEEP_IMPLEMENTATION"),
            vm.envAddress("SWEEP_FACTORY"),
            vm.envAddress("SWEEP_BATCHER"),
            vm.envAddress("SWEEP_PARENT"),
            vm.envAddress("SWEEP_OPERATOR"),
            vm.envOr("SWEEP_OWNER", vm.envAddress("SWEEP_PARENT"))
        );
        address ref = vm.envOr("BITGO_REFERENCE_FORWARDER", address(0));
        if (ref != address(0)) {
            ok(ref.code.length > 0, unicode"BitGo 官方部署的地址上有合约");
            ok(keccak256(stripMetadata(ref.code)) == keccak256(stripMetadata(d.implementation.code)),
                unicode"实现合约和 BitGo 官方部署的字节码一致（去掉元数据）");
        } else {
            console.log(unicode"没有填 BITGO_REFERENCE_FORWARDER：只和本仓库原样编译的结果比对");
        }
        check(d);
        printEnv(d);
    }
}
