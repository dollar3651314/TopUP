// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

/// TRON 测试网（Nile）验证用的合约，**只部署在测试网，不上主网**。用法见 scripts/tron-nile/README.md。
/// 要验证两件事：
///   ① 充值地址先被别人转了 TRX（账户被激活）之后，还能不能用 CREATE2 在同一地址部署转发合约；
///   ② TRON 的 CREATE2 地址前缀是 0x41：合约里按 0x41 算出的地址 = 后端离线算出的地址 = 链上实际部署出的地址。
/// 顺带记录 TRON 编译器对 `new C{salt: …}()` 用的是 0x41 还是 0xff（我们的代码不用这种写法，只记录结果）。

interface INileForwarderFactory {
    function implementationAddress() external view returns (address);
    function createForwarder(address parent, address feeAddress, bytes32 salt) external;
}

interface INileForwarderFlush {
    function flushTokens(address tokenContractAddress) external;
}

/// 最简单的测试代币：部署时把全部发行量给部署账户；transfer 成功返回 true（标准 ERC20 行为，
/// 不模拟 TRON USDT"成功也返回 false"的问题——那一条在第 2 批的派生合约里单独处理和测试）。
contract NileTestToken {
    string public constant name = "Nile Test Token";
    string public constant symbol = "NTT";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "allowance");
        allowance[from][msg.sender] = a - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// `new C{salt: …}()` 用的空合约
contract NileSaltDummy {
    uint256 public constant marker = 1;
}

/// 小号批量合约：它是所有转发地址的 feeAddress（和正式的批量合约一样），parent 是部署时写死的地址。
/// forwarderAddress41 就是 TRON 版批量合约 forwarderAddress() 要用的写法（把 0xff 换成 0x41），
/// forwarderAddressFF 是以太坊写法，留着做对照：两者在 TRON 上应当不同，链上实际地址应当等于 41 那个。
contract NileProbe {
    INileForwarderFactory public immutable factory;
    address public immutable parent;
    bytes32 public immutable proxyInitCodeHash;

    event ForwarderDeployed(bytes32 indexed salt, address predicted41, address predictedFF, uint256 codeSize);
    event Flushed(bytes32 indexed salt, address forwarder);
    event NewWithSalt(bytes32 indexed salt, address deployed, address predicted41, address predictedFF);

    constructor(INileForwarderFactory factory_, address parent_) {
        require(address(factory_) != address(0) && parent_ != address(0), "zero");
        factory = factory_;
        parent = parent_;
        proxyInitCodeHash = keccak256(
            abi.encodePacked(
                hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", factory_.implementationAddress(), hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
    }

    function finalSalt(bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encodePacked(parent, address(this), salt));
    }

    function forwarderAddress41(bytes32 salt) public view returns (address) {
        return _create2(bytes1(0x41), address(factory), finalSalt(salt), proxyInitCodeHash);
    }

    function forwarderAddressFF(bytes32 salt) public view returns (address) {
        return _create2(bytes1(0xff), address(factory), finalSalt(salt), proxyInitCodeHash);
    }

    function codeSize(address a) external view returns (uint256) {
        return a.code.length;
    }

    /// 用工厂部署转发合约（任何人都能调用工厂，这里由本合约调用，所以 feeAddress = 本合约）
    function create(bytes32 salt) external {
        factory.createForwarder(parent, address(this), salt);
        address a41 = forwarderAddress41(salt);
        emit ForwarderDeployed(salt, a41, forwarderAddressFF(salt), a41.code.length);
    }

    /// 把转发地址里某个代币的全部余额转给 parent（BitGo 代码只允许 parent 和 feeAddress 调用）
    function flush(address token, bytes32 salt) external {
        address f = forwarderAddress41(salt);
        INileForwarderFlush(f).flushTokens(token);
        emit Flushed(salt, f);
    }

    /// 记录 TRON 编译器的 `new C{salt}` 行为
    function newWithSalt(bytes32 salt) external returns (address deployed) {
        deployed = address(new NileSaltDummy{salt: salt}());
        bytes32 h = keccak256(type(NileSaltDummy).creationCode);
        emit NewWithSalt(salt, deployed, _create2(bytes1(0x41), address(this), salt, h), _create2(bytes1(0xff), address(this), salt, h));
    }

    function _create2(bytes1 prefix, address deployer, bytes32 salt, bytes32 initCodeHash) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(prefix, deployer, salt, initCodeHash)))));
    }
}
