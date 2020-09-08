import 'isomorphic-fetch';
import * as zksync from 'zksync';
import * as ethers from 'ethers';
import { saveConfig } from './config';
import { ALL_NETWORKS, Network, Wallet, Config, AccountInfo, TxInfo, TransferInfo } from './common';

export function apiServer(network: Network) {
    const servers = {
        localhost: 'http://localhost:3001',
        ropsten: 'https://ropsten-api.zksync.io',
        rinkeby: 'https://rinkeby-api.zksync.io',
        mainnet: 'https://api.zksync.io'
    };
    return `${servers[network]}/api/v0.1`;
}

export async function accountInfo(
    address: string,
    network: Network = 'localhost'
): Promise<AccountInfo> {
    const provider = await zksync.getDefaultProvider(network, 'HTTP');
    const state = await provider.getState(address);
    let balances: { [token: string]: string } = {};
    for (const token in state.committed.balances) {
        balances[token] = provider.tokenSet.formatToken(token, state.committed.balances[token]);
    }
    await provider.disconnect();
    return {
        address,
        network,
        account_id: state.id,
        nonce: state.committed.nonce,
        balances
    };
}

export async function txInfo(tx_hash: string, network: Network = 'localhost'): Promise<TxInfo> {
    const api_url = `${apiServer(network)}/transactions_all/${tx_hash}`;
    const response = await fetch(api_url);
    const tx = await response.json();
    if (tx === null) {
        return {
            network,
            transaction: null
        };
    }
    let info: TxInfo = {
        network,
        transaction: {
            status: tx.fail_reason ? 'error' : 'success',
            from: tx.from,
            to: tx.to,
            hash: tx_hash,
            operation: tx.tx_type,
            nonce: tx.nonce
        }
    };
    if (tx.token === -1) {
        return info;
    }
    const provider = await zksync.getDefaultProvider(network, 'HTTP');
    const tokens = await provider.getTokens();
    const tokenInfo = Object.values(tokens).find((value) => value.id == tx.token);
    if (tokenInfo) {
        const token = tokenInfo.symbol; // @ts-ignore
        info.transaction.amount = provider.tokenSet.formatToken(token, tx.amount);
        if (tx.fee) {
            // @ts-ignore
            info.transaction.fee = provider.tokenSet.formatToken(token, tx.fee);
        } // @ts-ignore
        info.transaction.token = token;
    } else {
        throw new Error('token not found');
    }
    return info;
}

export async function availableNetworks() {
    let networks: Network[] = [];
    for (const network of ALL_NETWORKS) {
        try {
            const provider = await zksync.getDefaultProvider(network, 'HTTP');
            await provider.disconnect();
            networks.push(network);
        } catch (err) {
            /* could not connect to provider */
        }
    }
    return networks;
}

export function defaultNetwork(config: Config, network?: Network) {
    if (network) {
        if (ALL_NETWORKS.includes(network)) {
            config.network = network;
            saveConfig(config);
        } else {
            throw new Error('invalid network name');
        }
    }
    return config.network;
}

export function addWallet(config: Config, privkey?: string) {
    const wallet = privkey ? new ethers.Wallet(privkey) : ethers.Wallet.createRandom();
    const address = wallet.address.toLowerCase();
    config.wallets.push({
        address,
        privkey: wallet.privateKey
    });
    if (!config.defaultWallet) {
        config.defaultWallet = address;
    }
    saveConfig(config);
    return wallet.address;
}

export function listWallets(config: Config) {
    let wallets: string[] = [];
    for (const { address } of config.wallets) {
        wallets.push(address);
    }
    return wallets;
}

export function removeWallet(config: Config, address: string) {
    address = address.toLowerCase();
    config.wallets = config.wallets.filter((w: Wallet) => w.address != address);
    if (config.defaultWallet === address) {
        config.defaultWallet = null;
    }
    saveConfig(config);
}

export function defaultWallet(config: Config, address?: string) {
    if (address) {
        address = address.toLowerCase();
        const addresses = config.wallets.map((w: Wallet) => w.address);
        if (addresses.includes(address)) {
            config.defaultWallet = address;
            saveConfig(config);
        } else {
            throw new Error('address is not present');
        }
    }
    return config.defaultWallet;
}

export async function transfer(
    config: Config,
    transferInfo: TransferInfo,
    network: Network = 'localhost'
): Promise<string> {
    const { token, amount, to, from } = transferInfo;
    const ethProvider =
        network == 'localhost'
            ? new ethers.providers.JsonRpcProvider()
            : ethers.getDefaultProvider(network);
    const syncProvider = await zksync.getDefaultProvider(network, 'HTTP');
    const privkey = config.wallets.find((w: Wallet) => w.address == from)?.privkey;
    if (!privkey) {
        throw new Error('address is not present');
    }
    const ethWallet = new ethers.Wallet(privkey).connect(ethProvider);
    const syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
    if (!(await syncWallet.isSigningKeySet())) {
        const changePubkey = await syncWallet.setSigningKey();
        await changePubkey.awaitReceipt();
    }
    const txHandle = await syncWallet.syncTransfer({
        to,
        token,
        amount: syncProvider.tokenSet.parseToken(token, amount)
    });
    await txHandle.awaitReceipt();
    await syncProvider.disconnect();
    const response = await fetch(`${apiServer(network)}/account/${to}/history/0/1`);
    const txList = await response.json();
    return txList[0].hash;
}

export async function deposit(
    config: Config,
    transferInfo: TransferInfo,
    network: Network = 'localhost'
): Promise<string> {
    const { token, amount, to, from } = transferInfo;
    const ethProvider =
        network == 'localhost'
            ? new ethers.providers.JsonRpcProvider()
            : ethers.getDefaultProvider(network);
    const syncProvider = await zksync.getDefaultProvider(network, 'HTTP');
    const privkey = config.wallets.find((w: Wallet) => w.address == from)?.privkey;
    if (!privkey) {
        throw new Error('address is not present');
    }
    const ethWallet = new ethers.Wallet(privkey).connect(ethProvider);
    const syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
    const depositHandle = await syncWallet.depositToSyncFromEthereum({
        depositTo: to,
        token,
        amount: syncProvider.tokenSet.parseToken(token, amount),
        approveDepositAmountForERC20: !zksync.utils.isTokenETH(token)
    });
    await depositHandle.awaitReceipt();
    await syncProvider.disconnect();
    const response = await fetch(`${apiServer(network)}/account/${to}/history/0/1`);
    const txList = await response.json();
    return txList[0].hash;
}
