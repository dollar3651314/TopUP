// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IForwarderFactoryV4, IForwarderV4Flush} from "../SweepBatcher.sol";

/// @title SweepBatcherTron：批量归集合约（../SweepBatcher.sol）的 TRON 版
/// @notice 和以太坊版逐行相同，只有一处差异：forwarderAddress() 按 TRON 的 CREATE2 规则用前缀 0x41（以太坊版写死 0xff）。
/// 工厂是 ForwarderFactoryTron（函数签名和 BitGo ForwarderFactoryV4 用到的两个相同，所以沿用 IForwarderFactoryV4）。
/// 碰不到钱：本合约不收也不持有任何代币或 TRX，没有能把钱转到任意地址的函数；钱永远由 ForwarderTron 转给部署时写死的 parent。
/// 单个地址失败（例如 USDT 冻结了这个地址）只发 SweepFailed，不影响同一批里的其他地址。
contract SweepBatcherTron is Ownable2Step {
    IForwarderFactoryV4 public immutable factory;
    address public immutable parent;
    bytes32 public immutable proxyInitCodeHash;

    mapping(address => bool) public isOperator;

    event OperatorSet(address indexed operator, bool allowed);
    event Swept(bytes32 indexed salt, address indexed forwarder, bool deployed);
    event SweepFailed(bytes32 indexed salt, address indexed forwarder, bytes reason);

    error NotOperator();
    error ZeroAddress();
    error RenounceDisabled();

    constructor(IForwarderFactoryV4 factory_, address parent_, address operator_) Ownable(msg.sender) {
        if (address(factory_) == address(0) || parent_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        factory = factory_;
        parent = parent_;
        proxyInitCodeHash = keccak256(
            abi.encodePacked(
                hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
                factory_.implementationAddress(),
                hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
        isOperator[operator_] = true;
        emit OperatorSet(operator_, true);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// 盐对应的转发地址（TRON：0x41 前缀）：和 ForwarderFactoryTron.createForwarder(parent, address(this), salt) 在 TRON 上部署出的地址相同
    function forwarderAddress(bytes32 salt) public view returns (address) {
        bytes32 finalSalt = keccak256(abi.encodePacked(parent, address(this), salt));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0x41), address(factory), finalSalt, proxyInitCodeHash))))
        );
    }

    function sweep(address token, bytes32[] calldata salts) external {
        if (!isOperator[msg.sender]) revert NotOperator();
        for (uint256 i; i < salts.length; ++i) {
            bytes32 salt = salts[i];
            address forwarder = forwarderAddress(salt);
            bool deploy = forwarder.code.length == 0;
            if (deploy) {
                try factory.createForwarder(parent, address(this), salt) {}
                catch (bytes memory reason) {
                    emit SweepFailed(salt, forwarder, reason);
                    continue;
                }
            }
            try IForwarderV4Flush(forwarder).flushTokens(token) {
                emit Swept(salt, forwarder, deploy);
            } catch (bytes memory reason) {
                emit SweepFailed(salt, forwarder, reason);
            }
        }
    }
}
