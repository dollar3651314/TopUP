// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

/// 测试用代币和多签替身（只在测试里用）。

/// 像以太坊主网 USDT：transfer 不返回 bool（老式 ERC20），6 位小数
contract MockUsdtNoReturn {
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
    }
}

/// 标准 ERC20（transfer 返回 bool），可设小数位：BSC 上的 USDT 是 18 位
contract MockErc20 {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}

/// transfer 返回 false 的代币（TransferHelper 会回滚）
contract MockFalseToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// transfer 直接回滚的代币（例如被冻结的地址）
contract MockRevertToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert("frozen");
    }
}

/// 冷钱包替身：能收原生币，所有者可以让它调用任意合约（相当于 Safe 执行一笔多签交易）
contract MockSafe {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    receive() external payable {}

    function exec(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == owner, "not owner");
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "exec failed");
        return ret;
    }
}

/// createForwarder 一定失败的工厂（只用来覆盖批量合约"部署失败"的分支）
contract MockBrokenFactory {
    address public immutable implementationAddress;

    constructor(address impl) {
        implementationAddress = impl;
    }

    function createForwarder(address, address, bytes32) external pure {
        revert("broken factory");
    }
}
