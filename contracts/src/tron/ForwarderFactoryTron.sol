// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

import {CloneFactory} from "bitgo/CloneFactory.sol";
import {ForwarderTron} from "./ForwarderTron.sol";

/// @title ForwarderFactoryTron：BitGo ForwarderFactoryV4（lib/eth-multisig-v4/contracts/ForwarderFactoryV4.sol，提交 9566bcd）的 TRON 派生版
/// @notice 用 CREATE2 部署指向 ForwarderTron 的 EIP-1167 代理（CloneFactory 原样引用上游 lib/，一行不改）。
/// TRON 上 CREATE2 的地址前缀是 0x41（由 TVM 按 TRON 规则算，合约这里不用改）；后端和 SweepBatcherTron 按 0x41 算同一个地址。
///
/// 和上游的差异：
///   1. 只有 createForwarder(parent, feeAddress, salt) 一个入口：上游另有带 autoFlush721 / autoFlush1155 的五参数版本，
///      三参数版通过 this.createForwarder(...) 外部调用它；ForwarderTron 删了 NFT 相关，这里直接部署、调用 init(parent, feeAddress)。
///   2. 事件 ForwarderCreated 去掉 autoFlush 两个字段。
/// finalSalt = keccak256(parent ‖ feeAddress ‖ salt) 和上游相同（地址算法不变）。
contract ForwarderFactoryTron is CloneFactory {
    address public immutable implementationAddress;

    event ForwarderCreated(address newForwarderAddress, address parentAddress, address feeAddress);

    constructor(address _implementationAddress) {
        implementationAddress = _implementationAddress;
    }

    function createForwarder(address parent, address feeAddress, bytes32 salt) external {
        bytes32 finalSalt = keccak256(abi.encodePacked(parent, feeAddress, salt));
        address payable clone = createClone(implementationAddress, finalSalt);
        require(clone != address(0), "Clone failed");
        emit ForwarderCreated(clone, parent, feeAddress);
        ForwarderTron(clone).init(parent, feeAddress);
    }
}
