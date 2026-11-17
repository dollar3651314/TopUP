// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title 批量打款合约（以太坊、BSC，第 3 批）
/// @notice 热钱包（payer）一笔交易付给多个收款人：对每一笔，从调用者自己的授权额度 transferFrom 直接到收款人。
/// 碰不到钱：本合约不收也不持有任何代币或原生币（没有 payable、receive、fallback），没有能把钱转到任意地址的函数；
/// 只能花调用者（热钱包）自己给本合约的额度，别的热钱包的额度用不到。
/// 一批里任何一笔失败（代币回滚、返回 false、代币地址没有代码、收款人是 0）整批回滚。
/// 只有 owner（冷钱包 Safe 多签）登记的热钱包能调用；owner 两步转移，不允许放弃。
/// 金额为 0 的笔不特别处理（交给代币）；转账收手续费的代币不做余额前后核对（后端只用 USDT）。
contract BatchPayout is Ownable2Step {
    /// 一批最多几笔（和后端 MAX_ITEMS_PER_TX、签名页面的解码上限一致）
    uint256 public constant MAX_ITEMS = 100;

    /// 能调用 pay 的热钱包
    mapping(address => bool) public isPayer;

    event PayerSet(address indexed payer, bool allowed);
    event Paid(bytes32 indexed batchId, address indexed to, uint256 amount);

    error NotPayer();
    error LengthMismatch();
    error TooManyItems();
    error EmptyBatch();
    error ZeroAddress();
    error RenounceDisabled();
    error NotContract();
    error TransferFailed(uint256 index);

    /// @param payer_ 第一个热钱包。owner 先是部署账户，随后 transferOwnership(Safe)，Safe 签 acceptOwnership（Ownable2Step）
    constructor(address payer_) Ownable(msg.sender) {
        if (payer_ == address(0)) revert ZeroAddress();
        isPayer[payer_] = true;
        emit PayerSet(payer_, true);
    }

    /// 增删热钱包（只有 owner = Safe）
    function setPayer(address payer, bool allowed) external onlyOwner {
        if (payer == address(0)) revert ZeroAddress();
        isPayer[payer] = allowed;
        emit PayerSet(payer, allowed);
    }

    /// 不允许放弃所有权：放弃后就再也换不了热钱包
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// 打款：to[i] 收 amount[i]，钱从调用者的授权额度里出；一笔失败整批回滚
    function pay(address token, bytes32 batchId, address[] calldata to, uint256[] calldata amount) external {
        if (!isPayer[msg.sender]) revert NotPayer();
        uint256 n = to.length;
        if (n != amount.length) revert LengthMismatch();
        if (n == 0) revert EmptyBatch();
        if (n > MAX_ITEMS) revert TooManyItems();
        // 地址上没有代码时，低级调用会"成功"且不返回数据：不能当成转账成功
        if (token.code.length == 0) revert NotContract();
        for (uint256 i; i < n; ++i) {
            address recipient = to[i];
            if (recipient == address(0)) revert ZeroAddress();
            // 兼容不返回 bool 的代币（以太坊 USDT）：调用成功且（没有返回数据，或返回 true）才算成功（BitGo TransferHelper 的写法）
            (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, msg.sender, recipient, amount[i]));
            if (!(ok && (ret.length == 0 || abi.decode(ret, (bool))))) revert TransferFailed(i);
            emit Paid(batchId, recipient, amount[i]);
        }
    }
}
