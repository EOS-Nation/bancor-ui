import { VuexModule, mutation, action, Module } from "vuex-class-component";
import { web3 } from "@/api/helpers";
import { ABISmartToken } from "@/api/ethConfig";
import { EthAddress } from "@/types/bancor";
import { fromWei } from "web3-utils";
import { shrinkToken } from '../swap/ethBancor';

const tx = (data: any) =>
  new Promise((resolve, reject) => {
    console.log("pumping into web3.eth.sendTransaction is...", data);
    web3.eth
      .sendTransaction(data)
      .on("transactionHash", hash => {
        console.log("returning a tx hash!", hash);
        resolve(hash);
      })
      .on("receipt", (receipt: any) => {
        console.log("receipt received", receipt);
      })
      .on("confirmation", (confirmationNumber: any, receipt: any) => {
        console.log({ confirmationNumber, receipt });
      })
      .on("error", error => reject(error));
  });

@Module({ namespacedPath: "ethWallet/" })
export class EthereumModule extends VuexModule {
  loggedInAccount: string = "";

  @mutation setLoggedInAccount(account: string) {
    this.loggedInAccount = account;
  }

  get isAuthenticated() {
    return this.loggedInAccount;
  }

  get ethereum() {
    // @ts-ignore
    return window["ethereum"];
  }

  @action async logout() {
    console.warn("Client cannot logout by itself, log out via MetaMask.");
  }

  @action async connect() {
    // @ts-ignore
    const accounts = await web3.currentProvider.enable();
    if (!accounts) throw new Error("Failed to find a Web3 compatible wallet.");
    this.setLoggedInAccount(accounts[0]);
    this.startListener();
    return accounts[0];
  }

  @action async startListener() {
    // @ts-ignore
    web3.currentProvider.publicConfigStore.on(
      "update",
      (x: {
        isUnlocked: boolean;
        isEnabled: boolean;
        selectedAddress: string;
        networkVersion: string;
        onboardingcomplete: boolean;
        chainId: string;
      }) => this.setLoggedInAccount(x.selectedAddress)
    );
  }

  @action async checkAlreadySignedIn() {
    if (this.ethereum) {
      if (this.ethereum.selectedAddress) {
        this.setLoggedInAccount(this.ethereum.selectedAddress);
        this.startListener();
      }
    }
  }

  @action async getBalance({
    accountHolder,
    tokenContractAddress,
    keepWei = false
  }: {
    accountHolder: EthAddress;
    tokenContractAddress: EthAddress;
    keepWei?: boolean
  }) {
    if (tokenContractAddress == "0xc0829421C1d260BD3cB3E0F06cfE2D52db2cE315") {
      const weiBalance = await web3.eth.getBalance(accountHolder);
      return Number(fromWei(weiBalance));
    } else {
      if (!tokenContractAddress) throw new Error("tokenContractAddress is falsy");
      const tokenContract = new web3.eth.Contract(
        // @ts-ignore
        ABISmartToken,
        tokenContractAddress
      );

      const [decimals, weiBalance] = await Promise.all([
        tokenContract.methods.decimals().call() as string,
        tokenContract.methods.balanceOf(accountHolder).call() as string
      ]);
      if (keepWei) return weiBalance;
      return Number(shrinkToken(weiBalance, Number(decimals)));
    }
  }

  @action async tx(params: any) {
    return tx(params);
  }

  @action async transfer({
    floatAmount,
    recipient
  }: {
    floatAmount: string;
    recipient: string;
  }) {
    if (!floatAmount) throw new Error("Float Amount required.");
    if (!web3.utils.isAddress(recipient))
      throw new Error("Recipient must be valid ETH address");
    const weiAmount = web3.utils.toWei(floatAmount);
    const value = web3.utils.toHex(weiAmount);
    const params = [
      {
        from: this.isAuthenticated,
        to: recipient,
        value
      }
    ];
    return this.tx(params);
  }
}

export const ethWallet = EthereumModule.ExtractVuexModule(EthereumModule);
