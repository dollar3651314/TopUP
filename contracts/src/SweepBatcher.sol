// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// BitGo ForwarderFactoryV4 里用到的两个函数
interface IForwarderFactoryV4 {
    function implementationAddress() external view returns (address);
    function createForwarder(address parent, address feeAddress, bytes32 salt) external;
}

/// BitGo ForwarderV4 里用到的函数：把这个转发地址里某个代币的全部余额转给 parent（只有 parent 和 feeAddress 能调用）
interface IForwarderV4Flush {
    function flushTokens(address tokenContractAddress) external;
}

/// @title 资金归集的批量合约
/// @notice 一笔交易里，对每个盐：转发地址还没部署就先用 BitGo 工厂部署，然后 flushTokens，钱进 parent（Safe 冷钱包）。
/// 它是所有转发地址的 feeAddress（写进了地址算法），只有 owner（Safe）登记的发起账户（operator）能调用。
/// 碰不到钱：本合约不收也不持有任何代币或原生币，没有能把钱转到任意地址的函数；钱永远由 BitGo 的代码转给部署时写死的 parent。
/// 单个地址失败（例如代币回滚）只发 SweepFailed，不影响同一批里的其他地址。
contract SweepBatcher is Ownable2Step {
    /// BitGo ForwarderFactoryV4
    IForwarderFactoryV4 public immutable factory;
    /// 冷钱包（Safe 多签），所有转发地址的 parent
    address public immutable parent;
    /// EIP-1167 最小代理初始化代码（指向工厂的实现合约）的哈希，算 CREATE2 地址用
    bytes32 public immutable proxyInitCodeHash;

    /// 能调用 sweep 的发起账户
    mapping(address => bool) public isOperator;

    event OperatorSet(address indexed operator, bool allowed);
    event Swept(bytes32 indexed salt, address indexed forwarder, bool deployed);
    event SweepFailed(bytes32 indexed salt, address indexed forwarder, bytes reason);

    error NotOperator();
    error ZeroAddress();
    error RenounceDisabled();

    /// @param factory_ BitGo ForwarderFactoryV4
    /// @param parent_ 冷钱包（Safe）
    /// @param operator_ 第一个发起账户（服务器上的 EOA）
    /// owner 先是部署账户，部署脚本随后 transferOwnership(Safe)，Safe 签 acceptOwnership（Ownable2Step）
    constructor(IForwarderFactoryV4 factory_, address parent_, address operator_) Ownable(msg.sender) {
        if (address(factory_) == address(0) || parent_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        factory = factory_;
        parent = parent_;
        proxyInitCodeHash = keccak256(
            abi.encodePacked(
                hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", factory_.implementationAddress(), hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
        isOperator[operator_] = true;
        emit OperatorSet(operator_, true);
    }

    /// 增删发起账户（只有 owner = Safe）
    function setOperator(address operator, bool allowed) external onlyOwner {
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    /// 不允许放弃所有权：放弃后就再也换不了发起账户
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// 盐对应的转发地址：和 BitGo 工厂 createForwarder(parent, address(this), salt) 部署出的地址相同
    function forwarderAddress(bytes32 salt) public view returns (address) {
        bytes32 finalSalt = keccak256(abi.encodePacked(parent, address(this), salt));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), finalSalt, proxyInitCodeHash)))));
    }

    /// 归集：对每个盐，没部署就部署，然后把 token 的全部余额转给 parent
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
