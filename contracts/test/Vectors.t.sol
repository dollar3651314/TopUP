// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.20;

import {Test, Vm} from "forge-std/Test.sol";
import {ForwarderV4} from "bitgo/ForwarderV4.sol";
import {ForwarderFactoryV4} from "bitgo/ForwarderFactoryV4.sol";
import {DepositSalt} from "../src/DepositSalt.sol";

/// CREATE2 充值地址的两套测试向量，用真的 BitGo 工厂逐个部署核对（后端 test/wallet-create2.test.js 读同样两份文件）：
///   - create2-vectors-topup.json：TopUP 的盐前缀 "topup-deposit"，盐由 DepositSalt.forCustomer 算；
///   - create2-vectors-upstream.json：上游参考实现的向量（盐前缀不同，以十六进制给出），证明算法本身和上游一致。
/// 需要 foundry.toml 的 fs_permissions 允许读 ../test/fixtures/wallet。
contract VectorsTest is Test {
    string constant TOPUP = "../test/fixtures/wallet/create2-vectors-topup.json";
    string constant UPSTREAM = "../test/fixtures/wallet/create2-vectors-upstream.json";

    function test_SaltPrefixIsTopup() public pure {
        assertEq(DepositSalt.forCustomer(1), keccak256(abi.encodePacked("topup-deposit", uint256(1))));
        assertEq(DepositSalt.forCustomer(2_147_483_647), keccak256(abi.encodePacked("topup-deposit", uint256(2_147_483_647))));
    }

    function test_TopupVectorsMatchRealFactory() public {
        _check(TOPUP, true);
    }

    function test_UpstreamVectorsMatchRealFactory() public {
        _check(UPSTREAM, false);
    }

    function _check(string memory file, bool topup) internal {
        string memory json = vm.readFile(file);
        address factoryAt = vm.parseJsonAddress(json, ".factory");
        address implAt = vm.parseJsonAddress(json, ".implementation");
        address[] memory parents = vm.parseJsonAddressArray(json, ".parents");
        address[] memory fees = vm.parseJsonAddressArray(json, ".feeAddresses");
        uint256[] memory seqs = vm.parseJsonUintArray(json, ".seqs");
        bytes32[] memory salts = vm.parseJsonBytes32Array(json, ".salts");
        address[] memory addrs = vm.parseJsonAddressArray(json, ".addresses");
        assertEq(addrs.length, 1000);
        bytes memory prefix = topup ? bytes("topup-deposit") : vm.parseJsonBytes(json, ".saltPrefixHex");

        deployCodeTo("ForwarderV4.sol:ForwarderV4", implAt);
        deployCodeTo("ForwarderFactoryV4.sol:ForwarderFactoryV4", abi.encode(implAt), factoryAt);
        ForwarderFactoryV4 factory = ForwarderFactoryV4(factoryAt);
        assertEq(factory.implementationAddress(), implAt);

        for (uint256 i; i < addrs.length; ++i) {
            assertEq(keccak256(abi.encodePacked(prefix, seqs[i])), salts[i], "salt");
            if (topup) assertEq(DepositSalt.forCustomer(seqs[i]), salts[i], "DepositSalt");
            vm.recordLogs();
            factory.createForwarder(parents[i], fees[i], salts[i]);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            (address created,,,,) = abi.decode(logs[logs.length - 1].data, (address, address, address, bool, bool));
            assertEq(created, addrs[i], "address");
            assertEq(ForwarderV4(payable(created)).parentAddress(), parents[i]);
        }
    }
}
