// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

/// TRON 版合约的测试代币（只在测试里用，不部署到任何正式网络）。
/// Foundry（EVM）和本机 TRON 私链端到端（TRON 官方编译器，scripts/tron-nile/compile.mjs）共用这一份。

/// 像 TRON 主网 USDT：transfer 把钱转了，但返回 false（BitGo 的 TransferHelper 会因此回滚）。
/// 另外可以冻结某个地址（像 USDT 的黑名单：被冻结的地址转出时回滚），用来做"同一批里一个地址失败"。
contract TronUsdtMock {
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public frozen;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function setFrozen(address who, bool on) external {
        frozen[who] = on;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!frozen[msg.sender], "frozen");
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return false;
    }
}

/// transfer 返回 true 但什么都没转（只看返回值就会误判成功）
contract LyingToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}

/// 转账时扣 1% 手续费（像 USDT 开启转账手续费）：parent 收到的比转出的少
contract FeeOnTransferToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        uint256 fee = amount / 100;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - fee;
        return true;
    }
}
