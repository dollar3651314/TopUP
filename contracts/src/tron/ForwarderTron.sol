// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

/// @title ForwarderTron：BitGo ForwarderV4（lib/eth-multisig-v4/contracts/ForwarderV4.sol，提交 9566bcd）的 TRON 派生版
/// @notice 充值地址：由 ForwarderFactoryTron 用 CREATE2 部署的 EIP-1167 代理指向这份实现。钱只会转给 init 时写死的 parentAddress。
///
/// 和上游 ForwarderV4 的差异（只改 TRON 必须改的，其余照抄上游的写法和报错文字）：
///   1. flushTokens：TRON 主网 USDT 的 transfer 成功也返回 false，上游 TransferHelper.safeTransfer 会因此回滚。
///      改为调用 transfer 后不看返回值，按"parent 的代币余额正好增加了转出的数额、本地址余额归零"判断成功，否则回滚
///      （返回 true 却没转、转少了（扣手续费的代币）、直接回滚的代币，都回滚）。
///   2. 去掉 receive() / fallback()（上游收到原生币时自动 flush）：TRON 用系统转账（TransferContract）发 TRX 不执行合约代码，
///      自动转发不可靠；保留任何人可调用的 flush() 把地址上的 TRX 转给 parent。init 时把已有的原生币转给 parent 保持上游原样
///      （地址在部署前先被转 TRX "激活"也能部署，R1）。
///   3. 删掉 NFT 相关（ERC721 / ERC1155 回调、flushERC721Token、flushERC1155Tokens、batchFlushERC1155Tokens、autoFlush 开关、
///      supportsInterface）：TRON 只收 USDT，少一块攻击面。init 因此只有 (parent, feeAddress) 两个参数。
///   4. 删掉 batchFlushERC20Tokens（批量合约每个地址只调一次 flushTokens，用不到）。
/// callFromParent（只有 parent 能调，处理意外情况）、onlyAllowedAddress（parent 和 feeAddress 才能 flushTokens）、
/// onlyUninitialized、事件 ForwarderDeposited 和上游相同。
contract ForwarderTron {
    /// @notice 钱只会转给这个地址（冷钱包）
    address public parentAddress;
    /// @notice 除 parent 外，能调用 flushTokens 的地址（批量合约 SweepBatcherTron）
    address public feeAddress;

    event ForwarderDeposited(address from, uint256 value, bytes data);

    modifier onlyAllowedAddress() {
        require(msg.sender == parentAddress || msg.sender == feeAddress, "Address is not allowed");
        _;
    }

    modifier onlyUninitialized() {
        require(parentAddress == address(0x0), "Already initialized");
        _;
    }

    /// @notice 初始化（工厂部署后立刻调用）；地址上已有的原生币转给 parent（同上游）
    function init(address _parentAddress, address _feeAddress) external onlyUninitialized {
        require(_parentAddress != address(0x0), "Invalid parent address");
        parentAddress = _parentAddress;
        require(_feeAddress != address(0x0), "Invalid fee address");
        feeAddress = _feeAddress;

        uint256 value = address(this).balance;
        if (value == 0) {
            return;
        }
        emit ForwarderDeposited(address(this), value, msg.data);
        (bool success,) = parentAddress.call{value: value}("");
        require(success, "Flush failed");
    }

    /// @notice 只有 parent 能调：代表这个地址调用别的合约（处理意外情况，同上游）
    function callFromParent(address target, uint256 value, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == parentAddress, "Only Parent");
        (bool success, bytes memory returnedData) = target.call{value: value}(data);
        require(success, "Parent call execution failed");
        return returnedData;
    }

    /// @notice 把这个地址上某个代币的全部余额转给 parent。差异 1：不看 transfer 的返回值，按余额变化判断成功
    function flushTokens(address tokenContractAddress) external onlyAllowedAddress {
        address self = address(this);
        address parent = parentAddress;
        uint256 forwarderBalance = _balanceOf(tokenContractAddress, self);
        if (forwarderBalance == 0) {
            return;
        }
        uint256 parentBefore = _balanceOf(tokenContractAddress, parent);
        // transfer(address,uint256)
        (bool success,) = tokenContractAddress.call(abi.encodeWithSelector(0xa9059cbb, parent, forwarderBalance));
        require(success, "Token transfer failed");
        uint256 parentAfter = _balanceOf(tokenContractAddress, parent);
        require(
            parentAfter >= parentBefore && parentAfter - parentBefore == forwarderBalance,
            "Parent did not receive the full amount"
        );
        require(_balanceOf(tokenContractAddress, self) == 0, "Tokens left on forwarder");
    }

    /// @notice 任何人都能调：把地址上的原生币（TRX）全部转给 parent（同上游 flush）
    function flush() public {
        uint256 value = address(this).balance;
        if (value == 0) {
            return;
        }
        emit ForwarderDeposited(msg.sender, value, msg.data);
        (bool success,) = parentAddress.call{value: value}("");
        require(success, "Flush failed");
    }

    function _balanceOf(address token, address who) private view returns (uint256) {
        // balanceOf(address)
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, who));
        require(ok && ret.length >= 32, "balanceOf failed");
        return abi.decode(ret, (uint256));
    }
}
