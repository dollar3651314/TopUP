// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

/// 充值地址的盐：keccak256("topup-deposit" ‖ 客户序号的 32 字节大端整数)。
/// 只给测试和脚本用（internal，不单独部署）；后端 server/wallet/create2.js 用同一算法，测试向量交叉核对。
library DepositSalt {
    function forCustomer(uint256 seq) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("topup-deposit", seq));
    }
}
