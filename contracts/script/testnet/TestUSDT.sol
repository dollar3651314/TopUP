// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

/// @title 测试网用的 USDT（只部署到 Sepolia、BSC 测试网、Nile 和本地链；scripts/testnet/deploy.mjs）
/// @notice 测试币，没有任何价值：小数位数和这条链主网的 USDT 一样（以太坊、TRON 6 位，BSC 18 位，后端按链换算）；
/// 谁都可以 mint，方便测试人员自己领。
/// tronStyle = true 时 transfer 成功也返回 false（像 TRON 主网 USDT），让测试环境走到和主网一样的分支；
/// transferFrom、approve 一律返回 true（以太坊版的批量打款合约用 transferFrom）。
contract TestUSDT {
    string public constant name = "TopUP Test USDT";
    string public constant symbol = "tUSDT";
    uint8 public immutable decimals;
    /// 一次最多 mint 多少（1 亿个，按最小单位），防止误填出天文数字
    uint256 public immutable maxMint;

    bool public immutable tronStyle;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// wholeTokens：部署时给 to 多少个（整数个，不是最小单位）
    constructor(uint8 decimals_, bool tronStyle_, address to, uint256 wholeTokens) {
        require(decimals_ == 6 || decimals_ == 18, "decimals must be 6 or 18");
        decimals = decimals_;
        maxMint = 100_000_000 * 10 ** uint256(decimals_);
        tronStyle = tronStyle_;
        if (wholeTokens > 0) _mint(to, wholeTokens * 10 ** uint256(decimals_));
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return !tronStyle;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _mint(address to, uint256 amount) private {
        require(to != address(0), "zero address");
        require(amount <= maxMint, "amount too large");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _move(address from, address to, uint256 amount) private {
        require(to != address(0), "zero address");
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
