import axios, { AxiosResponse } from "axios";
import { vxm } from "@/store";
import { JsonRpc } from "eosjs";
import {
  Asset,
  asset_to_number,
  Sym,
  symbol,
  number_to_asset
} from "eos-common";
import { rpc } from "./rpc";
import {
  TokenBalances,
  EosMultiRelay,
  Converter,
  TokenMeta,
  BaseToken,
  TokenBalanceReturn,
  TokenBalanceParam
} from "@/types/bancor";
import Web3 from "web3";
import { EosTransitModule } from "@/store/modules/wallet/eosWallet";
import wait from "waait";
import {
  buildConverterContract,
  shrinkToken,
  buildV28ConverterContract
} from "./ethBancorCalc";
import { sortByNetworkTokens } from "./sortByNetworkTokens";

export const networkTokens = ["BNT", "USDB"];

const eosRpc: JsonRpc = rpc;

interface TraditionalStat {
  supply: Asset;
  max_supply: Asset;
}

export const getSxContracts = async () => {
  const res = (await rpc.get_table_rows({
    code: "registry.sx",
    table: "swap",
    scope: "registry.sx"
  })) as {
    rows: {
      contract: string;
      ext_tokens: { sym: string; contract: string }[];
    }[];
  };
  return res.rows.map(set => ({
    contract: set.contract,
    tokens: set.ext_tokens.map(token => ({
      contract: token.contract,
      symbol: new Sym(token.sym).code().to_string()
    }))
  }));
};

export const findOrThrow = <T>(
  arr: T[],
  iteratee: (obj: T, index: number, arr: T[]) => unknown,
  message?: string
) => {
  const res = arr.find(iteratee);
  if (!res)
    throw new Error(message || "Failed to find object in find or throw");
  return res;
};

export const compareToken = (
  a: TokenBalanceParam | TokenBalanceReturn | BaseToken,
  b: TokenBalanceParam | TokenBalanceReturn | BaseToken
): boolean =>
  compareString(a.contract, b.contract) && compareString(a.symbol, b.symbol);

export const compareString = (stringOne: string, stringTwo: string) => {
  const strings = [stringOne, stringTwo];
  if (!strings.every(str => typeof str == "string"))
    throw new Error(
      `String one: ${stringOne} String two: ${stringTwo} one of them are falsy or not a string`
    );
  return stringOne.toLowerCase() == stringTwo.toLowerCase();
};

export const fetchBinanceUsdPriceOfBnt = async (): Promise<number> => {
  const res = await axios.get<{ mins: number; price: string }>(
    "https://api.binance.com/api/v3/avgPrice?symbol=BNTUSDT"
  );
  return Number(res.data.price);
};

export const fetchUsdPriceOfBntViaRelay = async (
  relayContractAddress = "0xE03374cAcf4600F56BDDbDC82c07b375f318fc5C"
): Promise<number> => {
  const contract = buildConverterContract(relayContractAddress);
  const res = await contract.methods
    .getReturn(
      "0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C",
      "0x309627af60F0926daa6041B8279484312f2bf060",
      "1000000000000000000"
    )
    .call();
  return Number(shrinkToken(res["0"], 18));
};

export const updateArray = <T>(
  arr: T[],
  conditioner: (element: T) => boolean,
  updater: (element: T) => T
) => arr.map(element => (conditioner(element) ? updater(element) : element));

export type Wei = string | number;
export type Ether = string | number;

export const web3 = new Web3(
  Web3.givenProvider ||
    "https://mainnet.infura.io/v3/da059c364a2f4e6eb89bfd89600bce07"
);

export const fetchReserveBalance = async (
  converterContract: any,
  reserveTokenAddress: string,
  versionNumber: number | string
): Promise<string> => {
  try {
    const res = await converterContract.methods[
      Number(versionNumber) >= 17 ? "getConnectorBalance" : "getReserveBalance"
    ](reserveTokenAddress).call();
    return res;
  } catch (e) {
    try {
      const res = await converterContract.methods[
        Number(versionNumber) >= 17
          ? "getReserveBalance"
          : "getConnectorBalance"
      ](reserveTokenAddress).call();
      return res;
    } catch (e) {
      throw new Error("Failed getting reserve balance" + e);
    }
  }
};

export const fetchTokenSymbol = async (
  contractName: string,
  symbolName: string
): Promise<Sym> => {
  const statRes: {
    rows: { supply: string; max_supply: string; issuer: string }[];
  } = await rpc.get_table_rows({
    code: contractName,
    scope: symbolName,
    table: "stat"
  });
  if (statRes.rows.length == 0)
    throw new Error(
      `Unexpected stats table return from tokenContract ${contractName} ${symbolName}`
    );
  const maxSupplyAssetString = statRes.rows[0].max_supply;
  const maxSupplyAsset = new Asset(maxSupplyAssetString);
  return maxSupplyAsset.symbol;
};

export const getBalance = async (
  contract: string,
  symbolName: string,
  precision?: number
): Promise<string> => {
  const account = isAuthenticatedViaModule(vxm.eosWallet);
  const res: { rows: { balance: string }[] } = await rpc.get_table_rows({
    code: contract,
    scope: account,
    table: "accounts",
    limit: 99
  });
  const balance = res.rows.find(balance =>
    compareString(
      new Asset(balance.balance).symbol.code().to_string(),
      symbolName
    )
  );

  if (!balance) {
    if (typeof precision == "number") {
      return number_to_asset(0, new Sym(symbolName, precision)).to_string();
    } else {
      const symbol = await fetchTokenSymbol(contract, symbolName);
      return number_to_asset(0, symbol).to_string();
    }
  }
  return balance.balance;
};

export const fetchTokenStats = async (
  contract: string,
  symbol: string
): Promise<TraditionalStat> => {
  const tableResult = await eosRpc.get_table_rows({
    code: contract,
    table: "stat",
    scope: symbol,
    limit: 1
  });
  const tokenExists = tableResult.rows.length > 0;
  if (!tokenExists) throw new Error("Token does not exist");
  const { supply, max_supply } = tableResult.rows[0];
  return {
    supply: new Asset(supply),
    max_supply: new Asset(max_supply)
  };
};

export const retryPromise = async <T>(
  promise: () => Promise<T>,
  maxAttempts = 10,
  interval = 1000
): Promise<T> => {
  return new Promise(async (resolve, reject) => {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        return resolve(await promise());
      } catch (e) {
        await wait(interval);
        if (i == maxAttempts) reject(e);
      }
    }
  });
};

export const getTokenBalances = async (
  accountName: string
): Promise<TokenBalances> => {
  const res = await axios.get<TokenBalances>(
    `https://eos.eosn.io/v2/state/get_tokens?account=${accountName}`
  );
  return res.data;
};

export const identifyVersionBySha3ByteCodeHash = (sha3Hash: string): string => {
  if (
    sha3Hash ==
    "0xf0a5de528f6d887b14706f0e66b20bee0d4c81078b6de9f395250e287e09e55f"
  )
    return "11";
  throw new Error("Failed to identify version of Pool");
};

export const getEthRelays = (): Relay[] => {
  const relays = [
    {
      tokenAddress: "0x83cee9e086A77e492eE0bB93C2B0437aD6fdECCc",
      symbol: "MNTP",
      smartTokenSymbol: "MNTPBNT",
      converterAddress: "0x0160AE697A3538668CDb4698d3B89C7F36AD990d",
      smartTokenAddress: "0x8DA321aB610cD24fB2bcCe191F423Dae7c327ca9",
      owner: "0x76a1E5FcC8176E76b9210B8dBC484258f8745200",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "36402697982751582400392",
      connectorBancorReserve: "32370430415522860709172",
      connectorOriginalReserve: "47094981742640611266281",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x5102791cA02FC3595398400BFE0e33d7B6C82267",
      symbol: "LDC",
      smartTokenSymbol: "LDCBNT",
      converterAddress: "0x0625eAb862cFf8B8489DCaE24AE7c624c6ae5dF6",
      smartTokenAddress: "0xB79C3a1a2d50CC99459F3a21D709bCEC86656e97",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "206372803522796976262000",
      connectorBancorReserve: "21801631989112540900724",
      connectorOriginalReserve: "63851168065122216688022251",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      symbol: "DAI(USDB)",
      smartTokenSymbol: "DAIUSDB",
      converterAddress: "0x06f7Bf937Dec0C413a2E0464Bb300C4d464bb891",
      smartTokenAddress: "0xcb913ED43e43cc7Cec1D77243bA381615101E7E4",
      owner: "0xf66cdB456dA006a56B393F08FceC377c6C1af28a",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "21798985252683201867029",
      connectorBancorReserve: "129533347932972772869505",
      connectorOriginalReserve: "130157014226570725284877",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.15",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xbf2179859fc6D5BEE9Bf9158632Dc51678a4100e",
      symbol: "ELF",
      smartTokenSymbol: "ELFBNT",
      converterAddress: "0x08B61dED2f558071FbDB827715E7aeF16e76DD4F",
      smartTokenAddress: "0x0F2318565f1996CB1eD2F88e172135791BC1FcBf",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "171710353301259888789431",
      connectorBancorReserve: "97167817374638408264560",
      connectorOriginalReserve: "412657435983459870054927",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xe8A1Df958bE379045E2B46a31A98B93A2eCDfDeD",
      symbol: "ESZ",
      smartTokenSymbol: "ESZBNT",
      converterAddress: "0x0A9ed23490CF8F89e750bBC3e28f96502bB45491",
      smartTokenAddress: "0xA2020e324C365D05e87cf25552E6e6734260b089",
      owner: "0xC7A965dCec421B8423De2d7b26EB83AAC8070aCC",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "10099998023675550955",
      connectorBancorReserve: "19475155663339907720",
      connectorOriginalReserve: "153033166800151200378",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xdB25f211AB05b1c97D595516F45794528a807ad8",
      symbol: "EURS",
      smartTokenSymbol: "EURSBNT",
      converterAddress: "0x0D86A7A059f316F81FcEF32495aAe41Cd0C80511",
      smartTokenAddress: "0xFC0e04Eae452c163883AAAd4Ac1AE091Cc87FEf3",
      owner: "0x2EbBbc541E8f8F24386FA319c79CedA0579f1Efb",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "125004174030988422601249",
      connectorBancorReserve: "167119937357341744590791",
      connectorOriginalReserve: "3333038",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 2,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x02F2D4a04E6E01aCE88bD2Cd632875543b2eF577",
      symbol: "PKG",
      smartTokenSymbol: "PKGBNT",
      converterAddress: "0x0dA9706F366C915D3769F7Ae9737Ef77c7741715",
      smartTokenAddress: "0xE729024679C29c2660E05727ECAfd3D8792b8111",
      owner: "0x8cd103c2164D04D071F4014Ac7b3Aa42D8FA596C",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "84960000000000000000",
      connectorBancorReserve: "42480000000000000000",
      connectorOriginalReserve: "1428571428571428600000000",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xEF2463099360a085f1f10b076Ed72Ef625497a06",
      symbol: "SHP",
      smartTokenSymbol: "SHPBNT",
      converterAddress: "0x0f1C029C5D7f626f6820bfe0F6a7B2Ac48746dDF",
      smartTokenAddress: "0x6e0E0B9aB5f8e5F5F2DE4D34FfE46668FFB37476",
      owner: "0xf21c7e5D4abf66Ecca96401288b71fA3e2eF9223",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "59354374541390473687332",
      connectorBancorReserve: "2116607192828093145",
      connectorOriginalReserve: "5056049469443635969013",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x6710c63432A2De02954fc0f851db07146a6c0312",
      symbol: "MFG",
      smartTokenSymbol: "MFGBNT",
      converterAddress: "0x0Fec04a7526F601a1019eDcD5d5B003101c46A0c",
      smartTokenAddress: "0xb3b2861a093B7FB19352bD62CD8EFC314e0641a7",
      owner: "0xc958B2C0b1219b79322c726CEd6Df753581bc9E5",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "63696996629749892917000",
      connectorBancorReserve: "16499787090186508188870",
      connectorOriginalReserve: "6257738629613948334568345",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x47bc01597798DCD7506DCCA36ac4302fc93a8cFb",
      symbol: "CMCT",
      smartTokenSymbol: "CMCTBNT",
      converterAddress: "0x10806d5d46E2fB1021fF65301a4375bd89e01577",
      smartTokenAddress: "0xb5b0E0642d35D7Cab64CDa6EcF87Fd842cB5c58d",
      owner: "0x2B5411cDaC5e35Be5ba0a20E40B62B87153820a0",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "49884000000000000000000",
      connectorBancorReserve: "17068675145765111233724",
      connectorOriginalReserve: "1096465871279885",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 8,
      conversionFee: "3",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
      symbol: "LINK(USDB)",
      smartTokenSymbol: "LINKUSDB",
      converterAddress: "0x1163EF21C285221B5BF9964B895a5128070A392b",
      smartTokenAddress: "0x6E4DB478e55745A8711eCFf193C9d95e970Eb001",
      owner: "0xdb1Ab9BD3207c6A0d3622fe8e48503696546A5B2",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "201971628131820320000",
      connectorBancorReserve: "114187399704800589308",
      connectorOriginalReserve: "51806898942375639161",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x9214eC02CB71CbA0ADA6896b8dA260736a67ab10",
      symbol: "REAL",
      smartTokenSymbol: "REALBNT",
      converterAddress: "0x1229e2a0711660BE162521f5626C68E85Ec99c7f",
      smartTokenAddress: "0xE9ADced9da076D9dADA35F5b99970fDd58B1440D",
      owner: "0x8E47702323fe2BC848481333253616DA2d8E743f",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "200105963365873433892592",
      connectorBancorReserve: "35313766998280905747821",
      connectorOriginalReserve: "380706187187510849938445",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x6888a16eA9792c15A4DCF2f6C623D055c8eDe792",
      symbol: "SIG",
      smartTokenSymbol: "SIGBNT",
      converterAddress: "0x150A46613a16B4256AcD227d00463BAa78B547Ec",
      smartTokenAddress: "0x09953e3e5C6Be303D8D83Ccb672d241abc9BEe29",
      owner: "0xbb640f38Ed9FbA04815DFABEFDD6f3eeBbBf38D0",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "843791556439145685",
      connectorBancorReserve: "164533620302227975",
      connectorOriginalReserve: "193565294273960445900",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xF1290473E210b2108A85237fbCd7b6eb42Cc654F",
      symbol: "HEDG",
      smartTokenSymbol: "HEDGBNT",
      converterAddress: "0x1c29f12d94AD2e6b5321Ce226b4550f83ce88fCA",
      smartTokenAddress: "0x654Ee2EAf2082c5483f2212ba7b6701F334a159f",
      owner: "0x3bd10fb3Cc28C9da48Fdc86F7B715F52A892e127",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "10441937378913891703728",
      connectorBancorReserve: "28035590671272514433441",
      connectorOriginalReserve: "3039020677071063557018",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x9B70740e708a083C6fF38Df52297020f5DfAa5EE",
      symbol: "DAN",
      smartTokenSymbol: "DANBNT",
      converterAddress: "0x20d23C7A4b2Ea38f9Dc885bd25b1BC8c2601D44d",
      smartTokenAddress: "0xa06cFAB8B584c91Df1aBee6e8503486AB4e23F40",
      owner: "0xAD55357e4f7acFF3f274399Dd27d8D9cf1Bb19aB",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "50593762501367796886000",
      connectorBancorReserve: "1639816660145087523349",
      connectorOriginalReserve: "2017929321032403",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 10,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x4Fabb145d64652a948d72533023f6E7A623C7C53",
      symbol: "BUSD(USDB)",
      smartTokenSymbol: "BUSDUSDB",
      converterAddress: "0x235d4FD0D13784c848712c30f2Da03925496FBd4",
      smartTokenAddress: "0xE94C892f90ABea59F3dd1D7d8c34aC9d7312F18A",
      owner: "0x3bF4EC1fAB53547e179cdbA1BF22C18a2d58B0B4",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "202000000000000000000",
      connectorBancorReserve: "101000000000000000000",
      connectorOriginalReserve: "102209406500000000000",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1001",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x5c872500c00565505F3624AB435c222E558E9ff8",
      symbol: "COT",
      smartTokenSymbol: "COTBNT",
      converterAddress: "0x24090349a627B3529F883A09A049F9bC3aD19479",
      smartTokenAddress: "0x19dB077A54dEa3fD4CBCd9d31D4dB297562CbD94",
      owner: "0x7035FB83a7C18289B94E443170BeE56b92DF8E46",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "3380274998655104820589",
      connectorBancorReserve: "1919269403878988736833",
      connectorOriginalReserve: "17846563734602351904888035",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.5",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x68d57c9a1C35f63E2c83eE8e49A64e9d70528D25",
      symbol: "SRN",
      smartTokenSymbol: "SRNBNT",
      converterAddress: "0x247AC58CD31541c65B3AAa47E047745107D13873",
      smartTokenAddress: "0xd2Deb679ed81238CaeF8E0c32257092cEcc8888b",
      owner: "0xdfeE8DC240c6CadC2c7f7f9c257c259914dEa84E",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "108351630383790308194306",
      connectorBancorReserve: "22546037253311280863881",
      connectorOriginalReserve: "894493898093716357530718",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xdd974D5C2e2928deA5F71b9825b8b646686BD200",
      symbol: "KNC",
      smartTokenSymbol: "KNCBNT",
      converterAddress: "0x2493774B43EF7F6D2F4bc39a535Cd2b5b765cBF8",
      smartTokenAddress: "0x248AFFf1aa83cF860198ddeE14b5b3E8eDb46d47",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "123527414225661759707612",
      connectorBancorReserve: "121210659721069561928447",
      connectorOriginalReserve: "136035360070942313835958",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xCf8f9555D55CE45a3A33a81D6eF99a2a2E71Dee2",
      symbol: "CBIX7(USDB)",
      smartTokenSymbol: "CBIX7USDB",
      converterAddress: "0x27004767B074C36092e98886c8D4781a14c3CF3b",
      smartTokenAddress: "0xE35a57AC913144AEf6a4b179634D343466DE3Cc3",
      owner: "0x4D37f28D2db99e8d35A6C725a5f1749A085850a3",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "2620000000000000000",
      connectorBancorReserve: "14011122334012410223",
      connectorOriginalReserve: "1201612568871371774336",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x98Bde3a768401260E7025FaF9947ef1b81295519",
      symbol: "BCS",
      smartTokenSymbol: "BCSBNT",
      converterAddress: "0x27f8fd3ac4eAa50068B8F221bFa0b496F180813e",
      smartTokenAddress: "0xD3aD4c39A12B48164068Fef8F86eF5836A9eF303",
      owner: "0xB9C5F14e5E460Ef926e5772783992F686FC2D3c4",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "29046000000000000000000",
      connectorBancorReserve: "7416943950024663865093",
      connectorOriginalReserve: "20150464258833962044426",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "13"
    },
    {
      tokenAddress: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      symbol: "WBTC",
      smartTokenSymbol: "WBTC",
      converterAddress: "0x2801cd0e845874085597865f5B5773f3e44dcDF0",
      smartTokenAddress: "0xFEE7EeaA0c2f3F7C7e6301751a8dE55cE4D059Ec",
      owner: "0x24eeb25be492d161bB2e78773463a1C2645d3E1D",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "57600000000000000000000",
      connectorBancorReserve: "62217171992382193738784",
      connectorOriginalReserve: "170705847",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 8,
      conversionFee: "0.5",
      converterVersion: "11"
    },
    {
      tokenAddress: "0xC011A72400E58ecD99Ee497CF89E3775d4bd732F",
      symbol: "SNX(USDB)",
      smartTokenSymbol: "SNXUSDB",
      converterAddress: "0x296089F31af0648C1B0eFE1234527F85CDbC071C",
      smartTokenAddress: "0xdf4971E3F52f5828C72A0512d560F54bFB2B2692",
      owner: "0xB024Fbc56AE323a05B5b6156C0FCC5001Fa5Ac9e",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "0",
      connectorBancorReserve: "0",
      connectorOriginalReserve: "0",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.2",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x0f7F961648aE6Db43C75663aC7E5414Eb79b5704",
      symbol: "XIO(USDB)",
      smartTokenSymbol: "XIOUSDB",
      converterAddress: "0x29e44d82303c4F9417B3A6E2e0f61314eAE84375",
      smartTokenAddress: "0x18D8001D1Da44fE96f442f5980e08D2Ab4e19594",
      owner: "0x5f7a009664B771E889751f4FD721aDc439033ECD",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "500000000000000000",
      connectorBancorReserve: "110000000000000000",
      connectorOriginalReserve: "7664907400000000000",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0",
      converterVersion: "22"
    },
    {
      tokenAddress: "0xEa6d4D7B36C00B3611dE0B0e1982B12E9e736c66",
      symbol: "ACD",
      smartTokenSymbol: "ACDBNT",
      converterAddress: "0x29f6Ae0f0c85b472Dc792CeF36e5690E1d3f7255",
      smartTokenAddress: "0x075561230DB23aa3B86ABE8AFE8bbc4eCDdf1C5A",
      owner: "0xC0eca50D76F8F0C92b20Bb312963D10e660c271d",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "5439337895951637000",
      connectorBancorReserve: "5226233911934720890",
      connectorOriginalReserve: "26067332779696732190",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
      symbol: "MKR(USDB)",
      smartTokenSymbol: "MKRUSDB",
      converterAddress: "0x2A1eAa24Ec7fF662157Bc8345a3e41cFdCE1Fdbe",
      smartTokenAddress: "0x29dF79CB535f1fe82cA65d52cB8B5EE82D7E98a6",
      owner: "0x3bF4EC1fAB53547e179cdbA1BF22C18a2d58B0B4",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "204000000000000000000",
      connectorBancorReserve: "102467997827388826128",
      connectorOriginalReserve: "224318642277473879",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1001",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x47Ec6AF8E27C98e41d1Df7fb8219408541463022",
      symbol: "EFOOD",
      smartTokenSymbol: "EFOODBNT",
      converterAddress: "0x2A432989CFbAE00e807Bd8Cb414B657F1B74E5c7",
      smartTokenAddress: "0xf34484286be88613ad8399fe40f93506125be139",
      owner: "0x1Ce8d11d788aE92cc1E457d5e8e87472B54CD6db",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "131770000000000000000000",
      connectorBancorReserve: "3043918789535489660968",
      connectorOriginalReserve: "10732766697755915195733405",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x607F4C5BB672230e8672085532f7e901544a7375",
      symbol: "RLC(USDB)",
      smartTokenSymbol: "RLCUSDB",
      converterAddress: "0x2B4f0AD32a8aC2075648A054D6082727e21eD053",
      smartTokenAddress: "0x6534d2A69c2C7774DF42A55A1678bD008984B324",
      owner: "0xdb1Ab9BD3207c6A0d3622fe8e48503696546A5B2",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "202000000000000000000",
      connectorBancorReserve: "101000000000000000000",
      connectorOriginalReserve: "257980000000",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 9,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x9AF839687F6C94542ac5ece2e317dAAE355493A1",
      symbol: "HOT",
      smartTokenSymbol: "HOTBNT",
      converterAddress: "0x2BeA21613B6c2C129d3F714c702008cDD3dD995B",
      smartTokenAddress: "0x0Ac0e122D09cC4DA4A96Cc2731D2b7cc1f8b025a",
      owner: "0x8B102C690b3409113609220bf8E60F458668e9b7",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "86471446339348483",
      connectorBancorReserve: "688001088428492822",
      connectorOriginalReserve: "6320971156311400336",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "19"
    },
    {
      tokenAddress: "0xf04a8ac553FceDB5BA99A64799155826C136b0Be",
      symbol: "FLIXX",
      smartTokenSymbol: "FLIXXBNT",
      converterAddress: "0x2cE573C05c9b8F6ef1a476cc40250972F1f3D63C",
      smartTokenAddress: "0x2d5aDD875442023eC83718Bb03D866c9F4C6E8cE",
      owner: "0x0040C769b501805c6Ebd77E3e2c64073Fe4EbD69",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "57648000099205463245685",
      connectorBancorReserve: "41816556534116604762748",
      connectorOriginalReserve: "1230760540803085659722503",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xA15C7Ebe1f07CaF6bFF097D8a589fb8AC49Ae5B3",
      symbol: "NPXS",
      smartTokenSymbol: "NPXSBNT",
      converterAddress: "0x2d56D1904bb750675c0A55Ca7339f971F48d9DdA",
      smartTokenAddress: "0x5a4deB5704C1891dF3575d3EecF9471DA7F61Fa4",
      owner: "0xC7A965dCec421B8423De2d7b26EB83AAC8070aCC",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "284964831678810937764018",
      connectorBancorReserve: "237930888921525056",
      connectorOriginalReserve: "1088840655573164753",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x41AB1b6fcbB2fA9DCEd81aCbdeC13Ea6315F2Bf2",
      symbol: "XDCE",
      smartTokenSymbol: "XDCEBNT",
      converterAddress: "0x2dAD2c84f6c3957Ef4B83a5DF6F1339Dfd9E6080",
      smartTokenAddress: "0xd1BB51fECC950c7b1e4197D8d13A1d2A60795D2C",
      owner: "0x9f016621D0eFF0777E77919342441C9734Fa3cB2",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "83240231056456764704435",
      connectorBancorReserve: "87146112040023471687903",
      connectorOriginalReserve: "18764458620874405928432739",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x780116D91E5592E58a3b3c76A351571b39abCEc6",
      symbol: "BOXX",
      smartTokenSymbol: "BOXXBNT",
      converterAddress: "0x3167cc146d228C6977dCbadA380dF926b39865b1",
      smartTokenAddress: "0x849D49911cEF804bdB1FEC58150B8EabAB119796",
      owner: "0x61cf78Ba23ED3D7e48D7aC4Fd87Fe0809F56b718",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "108338000000000000000000",
      connectorBancorReserve: "16971387435442614943039",
      connectorOriginalReserve: "819478312629433308658",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 15,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xFc2C4D8f95002C14eD0a7aA65102Cac9e5953b5E",
      symbol: "RBLX",
      smartTokenSymbol: "RBLXBNT",
      converterAddress: "0x32131848eDc60E032aBf0369241D34ec969EBf90",
      smartTokenAddress: "0x78AcF38ec85A9E4B2B88961b9D4BffbA04FdbA59",
      owner: "0xc6B55EDB22BDBb2D0eE1690B4A186F0cdf45EB0B",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "10427164931536240884475",
      connectorBancorReserve: "16015500738895114722021",
      connectorOriginalReserve: "30205345720493323547430",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xFB1e5F5e984C28Ad7E228CDaA1F8A0919BB6a09B",
      symbol: "GES",
      smartTokenSymbol: "GESBNT",
      converterAddress: "0x32d4fb837f41955b81556F74DAdB2C5b8a0D0989",
      smartTokenAddress: "0x5972CED550248B17c9F674639D33E5446b6ad95A",
      owner: "0x637cb461eD6dE06C0273cad30Cb646d5186a87e7",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "2038257172457514256133",
      connectorBancorReserve: "7571123236780017376",
      connectorOriginalReserve: "74740374277170850581682",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x1b22C32cD936cB97C28C5690a0695a82Abf688e6",
      symbol: "WISH",
      smartTokenSymbol: "WISHBNT",
      converterAddress: "0x38a3Fc625DF834dD34e8EDE60E10Cd3024a6650E",
      smartTokenAddress: "0x1C9Df905571B22214Fa5FB10ad99ebe327f199C5",
      owner: "0x00A0A886D73ce0F830692531f05E95a7e9c4d38a",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "7078004831622465983737",
      connectorBancorReserve: "2867540206696828535556",
      connectorOriginalReserve: "75909362850392930172461",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT(USDB)",
      smartTokenSymbol: "USDTUSDB",
      converterAddress: "0x39e5AAE547752c1239b4738e75cDF705c25adeA6",
      smartTokenAddress: "0xF2ff22976B973d6bcC17a7dC93B719162ADA2045",
      owner: "0xF29C685f9f11A0634EA5bEc83fb2c47e2101FC31",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "362828938569328935978",
      connectorBancorReserve: "1265698110457936646212",
      connectorOriginalReserve: "1254225660",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 6,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xb056c38f6b7Dc4064367403E26424CD2c60655e1",
      symbol: "CEEK",
      smartTokenSymbol: "CEEKBNT",
      converterAddress: "0x3a706Af4BfC1D30394256a434E092E23f611e39b",
      smartTokenAddress: "0x2F2ad6954d99Ea14fA145B9AB0fb6BA5Ac32c0Ee",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "70352000000000000000000",
      connectorBancorReserve: "33030668692777855961526",
      connectorOriginalReserve: "3193448617083132888898649",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x0000000000085d4780B73119b644AE5ecd22b376",
      symbol: "TUSD(USDB)",
      smartTokenSymbol: "TUSDUSDB",
      converterAddress: "0x3a8CC07F17Eb10E628c74B1a442c7ADC2BfD854D",
      smartTokenAddress: "0x06cd5923593a359111cDec66E74c62E831C8aEab",
      owner: "0xf66cdB456dA006a56B393F08FceC377c6C1af28a",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "220000000000000000000",
      connectorBancorReserve: "992264953347667980329",
      connectorOriginalReserve: "987810392017751313976",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.15",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xc12d099be31567add4e4e4d0D45691C3F58f5663",
      symbol: "AUC",
      smartTokenSymbol: "AUCBNT",
      converterAddress: "0x3B0116363e435D9E4EF24ecA6282a21b7CC662df",
      smartTokenAddress: "0x164A1229F4826C9dd70Ee3D9f4f3d7B68a172153",
      owner: "0x530dDbc6C29C87Bee72c1aB79867ac162e130bcB",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "108912489530614453884081",
      connectorBancorReserve: "7472817933822461513698",
      connectorOriginalReserve: "642246747998183970979055",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x340D2bdE5Eb28c1eed91B2f790723E3B160613B7",
      symbol: "VEE",
      smartTokenSymbol: "VEEBNT",
      converterAddress: "0x3B42239a8bc2f07bb16b17578fE44fF2422C16F6",
      smartTokenAddress: "0xc9c3A465380bFaaC486C89ff7d5F60CC275D4E08",
      owner: "0x0c4F2808D0c65f498ED0D38e46Da1E5dc524c3C3",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "74048577731910640696192",
      connectorBancorReserve: "22667458012194615001476",
      connectorOriginalReserve: "5306508239350528459850696",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xB8c77482e45F1F44dE1745F52C74426C631bDD52",
      symbol: "BNB",
      smartTokenSymbol: "BNBBNT",
      converterAddress: "0x3CfD18F931d449405dDC26E6B5b6B90F181f5bb9",
      smartTokenAddress: "0xE6b31fB3f29fbde1b92794B0867A315Ff605A324",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "46965681043738332887796",
      connectorBancorReserve: "160966601943740448058573",
      connectorOriginalReserve: "2444076768531213892820",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x6810e776880C02933D47DB1b9fc05908e5386b96",
      symbol: "GNO",
      smartTokenSymbol: "GNOBNT",
      converterAddress: "0x3f7Ba8B8F663fdDB47568CCA30eac7aeD3D2F1A3",
      smartTokenAddress: "0xd7eB9DB184DA9f099B84e2F86b1da1Fe6b305B3d",
      owner: "0xC7A965dCec421B8423De2d7b26EB83AAC8070aCC",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "206661803298417239390833",
      connectorBancorReserve: "113093699083084506770461",
      connectorOriginalReserve: "2202664400740322220817",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x1234567461d3f8Db7496581774Bd869C83D51c93",
      symbol: "CAT",
      smartTokenSymbol: "CATBNT",
      converterAddress: "0x42a348a8B718632A23E27c54978e060350f9dd10",
      smartTokenAddress: "0xB3c55930368D71F643C3775869aFC73f6c5237b2",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "31175082725497144318695",
      connectorBancorReserve: "1740937347878662012699",
      connectorOriginalReserve: "6224735321352144293989110",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x89303500a7Abfb178B274FD89F2469C264951e1f",
      symbol: "REF",
      smartTokenSymbol: "REFBNT",
      converterAddress: "0x4E2C46b4E86A17aD942B2Cd6F84302AeE4196A60",
      smartTokenAddress: "0xB67FA7330154878cF1Fd8F4b20bf1C19F68a3926",
      owner: "0x3e5E7e3F87C8055f4abB3D27dFB06853356a8F91",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "15928000000000000000000",
      connectorBancorReserve: "5818045226132971986448",
      connectorOriginalReserve: "1391209841891",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 8,
      conversionFee: "0.1",
      converterVersion: "11"
    },
    {
      tokenAddress: "0xBC86727E770de68B1060C91f6BB6945c73e10388",
      symbol: "XNK",
      smartTokenSymbol: "XNKBNT",
      converterAddress: "0x4f138e1CEeC7b33dfA4f3051594Ec016a08c7513",
      smartTokenAddress: "0x1B4D8c62DdF6947616a5FCda4Ca40A8715d2a4cb",
      owner: "0xc5bA7157b5B69B0fAe9332F30719Eecd79649486",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "60944000000000000000000",
      connectorBancorReserve: "19368140823654269116777",
      connectorOriginalReserve: "7780868125978466886363386",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x27f610BF36ecA0939093343ac28b1534a721DBB4",
      symbol: "WAND",
      smartTokenSymbol: "WANDBNT",
      converterAddress: "0x4F88DFc8e1D7bA696Db158656457797cfBDfB844",
      smartTokenAddress: "0x6a46f6DC570A1304a23f771c26b1802DFfcDAB0D",
      owner: "0x58866ce6A2fB0b52a5b3D18035Bc2fA9E6DDa0e3",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "41528000000000000000000",
      connectorBancorReserve: "13039827565501633687594",
      connectorOriginalReserve: "546918942586844114823687",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x1dEa979ae76f26071870F824088dA78979eb91C8",
      symbol: "SPD",
      smartTokenSymbol: "SPDBNT",
      converterAddress: "0x5039D9B575bD5722d310AF6D2fC11e053c6D03DA",
      smartTokenAddress: "0xb2F40825d32b658d39e4F73bB34D33BA628e8B76",
      owner: "0xa0c25589bE45283d66911dBC60C1686041C2235D",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "61014000000000000000000",
      connectorBancorReserve: "9694726119796752229946",
      connectorOriginalReserve: "30725910988741872810773545",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x1d462414fe14cf489c7A21CaC78509f4bF8CD7c0",
      symbol: "CAN",
      smartTokenSymbol: "CANBNT",
      converterAddress: "0x5142127A6703F5Fc80BF11b7b57fF68998F218E4",
      smartTokenAddress: "0x854809B0C072d9C9C09E268cd7836d1b58101B62",
      owner: "0x856D41AB6e3128bd9f49E168230CD78cE7C1E045",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "46908000000000000000000",
      connectorBancorReserve: "23016594202149199567946",
      connectorOriginalReserve: "301184595432",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 6,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x9Cb2f26A23b8d89973F08c957C4d7cdf75CD341c",
      symbol: "DZAR(USDB)",
      smartTokenSymbol: "DZARUSDB",
      converterAddress: "0x53106713B160C41634D78A9D5E15D252CCf03d0C",
      smartTokenAddress: "0x7484867773Bc6f3110f710577d36A3605DBa59DF",
      owner: "0x4D37f28D2db99e8d35A6C725a5f1749A085850a3",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "11156620000000000000000",
      connectorBancorReserve: "5332394502522134759815",
      connectorOriginalReserve: "80254864865",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 6,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x0f7F961648aE6Db43C75663aC7E5414Eb79b5704",
      symbol: "XIO",
      smartTokenSymbol: "XIOBNT",
      converterAddress: "0x5a83a9787278f9F864FEE46C5E151A504b79D4d4",
      smartTokenAddress: "0x0Edba1E9270AeE20ad93Ad19052d71900309AA35",
      owner: "0x5f7a009664B771E889751f4FD721aDc439033ECD",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "0",
      connectorBancorReserve: "0",
      connectorOriginalReserve: "0",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x9a794Dc1939F1d78fa48613b89B8f9d0A20dA00E",
      symbol: "ABX",
      smartTokenSymbol: "ABXBNT",
      converterAddress: "0x5A9f1cD844cE91AAADAA03059677EeBCf3CF00df",
      smartTokenAddress: "0x275a1a2Dad3075bEb96AF4f7fD93ade99bB0151f",
      owner: "0xa281961E6826c8700DC0F90F6c19537e1F107934",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "134636000000000000000000",
      connectorBancorReserve: "25153448147049091565797",
      connectorOriginalReserve: "1131828133036498915514308",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x222eFe83d8cC48e422419d65Cf82D410A276499B",
      symbol: "SXL",
      smartTokenSymbol: "SXLBNT",
      converterAddress: "0x5C03354cbaB446CA3Cb426513f11f684724636f7",
      smartTokenAddress: "0x3364ccAedE016F4C433B326d96bE1A2eafA60bdD",
      owner: "0x6bA2aef9481AdCb8b4101e54F30E2ebbF63C00f8",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "106750000000000000000000",
      connectorBancorReserve: "6310215941192957460155",
      connectorOriginalReserve: "2527063798",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 4,
      conversionFee: "0.1",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x737F98AC8cA59f2C68aD658E3C3d8C8963E40a4c",
      symbol: "AMN",
      smartTokenSymbol: "AMNBNT",
      converterAddress: "0x5caa37CBa585C216D39e3a02D8C0DFd4843cA5f9",
      smartTokenAddress: "0x0f9Be347378a37CED33A13AE061175AF07CC9868",
      owner: "0x37a9e1632624662e564F4a03895B3C615de0CFE8",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "43590203449080756865498",
      connectorBancorReserve: "19704793088689001319883",
      connectorOriginalReserve: "4554378199157090150123573",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "23"
    },
    {
      tokenAddress: "0xEDD7c94FD7B4971b916d15067Bc454b9E1bAD980",
      symbol: "ZIPT",
      smartTokenSymbol: "ZIPTBNT",
      converterAddress: "0x5dCf7AE55C91e0216d9Ff5BEc88924640F1F9581",
      smartTokenAddress: "0xC4a01182ab1e502a1C1d17024e4924573CE001CC",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "65793476247114683541980",
      connectorBancorReserve: "21713892918286041455335",
      connectorOriginalReserve: "2744450488649873848630716",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x3d1BA9be9f66B8ee101911bC36D3fB562eaC2244",
      symbol: "RVT",
      smartTokenSymbol: "RVTBNT",
      converterAddress: "0x635C9C9940D512bF5CB455706a28F9C7174d307f",
      smartTokenAddress: "0x5039f60594Ffa3f1a5ACbe85E1eBe12Dc8Da7c5c",
      owner: "0xD75BE1a4dE57B54DABC17EEEf2c3c87BB3ed14AD",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "504655900375461168485042",
      connectorBancorReserve: "42785457718872106688717",
      connectorOriginalReserve: "1061661073389856876111285",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x8A9C67fee641579dEbA04928c4BC45F66e26343A",
      symbol: "JRT(USDB)",
      smartTokenSymbol: "JRTUSDB",
      converterAddress: "0x66540A3fcD929774a8dab59d56fE7A2D3538450F",
      smartTokenAddress: "0x4827e558e642861Cd7a1C8f011b2B4661F8d51fa",
      owner: "0x03C2Bc72A3E007179E54fFb4563cc235beC8151a",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "1057711906163613375750",
      connectorBancorReserve: "129046050654182911143",
      connectorOriginalReserve: "21925712384317614548654",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xBB1fA4FdEB3459733bF67EbC6f893003fA976a82",
      symbol: "PAT",
      smartTokenSymbol: "XPATBNT",
      converterAddress: "0x66C5603fb424fd9f2e3A0fD51Ff63eEEc9857Bc3",
      smartTokenAddress: "0xEe769CE6B4E2C2A079c5f67081225Af7C89F874C",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "60788607817909658170964",
      connectorBancorReserve: "3639177495922188463111",
      connectorOriginalReserve: "402255069188586497962226046",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x814e0908b12A99FeCf5BC101bB5d0b8B5cDf7d26",
      symbol: "MDT",
      smartTokenSymbol: "MDTBNT",
      converterAddress: "0x6850809AAac4ceD0F453D7f4edafC5Bb6D0F96Dd",
      smartTokenAddress: "0xbAb15d72731Ea7031B10324806E7AaD8448896D5",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "109156000000000000000000",
      connectorBancorReserve: "91621442371254412672021",
      connectorOriginalReserve: "2454898051728048158833526",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x6c37Bf4f042712C978A73e3fd56D1F5738dD7C43",
      symbol: "ELET",
      smartTokenSymbol: "ELETBNT",
      converterAddress: "0x6909F6aE629e4500742221E86bF1ECac5d71d68d",
      smartTokenAddress: "0x334C36Be5b1EaF0C4b61dDEa202c9f6Dc2640FE5",
      owner: "0x92F2c7C8bcEEc7E333096d25Db0CE7c827a74205",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "264808607105403721778704",
      connectorBancorReserve: "42686660200433318995777",
      connectorOriginalReserve: "1573134589006463337574597",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "2",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x0cB20b77AdBe5cD58fCeCc4F4069D04b327862e5",
      symbol: "MGT2",
      smartTokenSymbol: "MGTBNT2",
      converterAddress: "0x6aD9C98E25D8E8292514ef108043278eeC34a27b",
      smartTokenAddress: "0x6F60D44A0d6fB95E037A099F8642f949c959a363",
      owner: "0x62D1A07747452E9594CBf3F2fF2c661d8ab827c1",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "49999999880532610000",
      connectorBancorReserve: "112194513447639012",
      connectorOriginalReserve: "100250000000",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 8,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x4a57E687b9126435a9B19E4A802113e266AdeBde",
      symbol: "FXC",
      smartTokenSymbol: "FXCBNT",
      converterAddress: "0x6b2c2db78Fc5F1f0A7a7a6d91d26922850A9C693",
      smartTokenAddress: "0xb93Cc8642f5e8644423Aa7305da96FFF75708228",
      owner: "0x9254F1f3441ebDf8e5667b2C766EA88C7D34f3BD",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "86433972738643270651103",
      connectorBancorReserve: "48846360715187098450792",
      connectorOriginalReserve: "4772248638060427415914870",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0",
      converterVersion: "11"
    },
    {
      tokenAddress: "0xa3d58c4E56fedCae3a7c43A725aeE9A71F0ece4e",
      symbol: "MET(USDB)",
      smartTokenSymbol: "METUSDB",
      converterAddress: "0x6bA3e97Dee101Edacc3b58ED59273693aCB4c79e",
      smartTokenAddress: "0x7F8c53072d9B809A108b1A9D677Bcc3B7B3F844e",
      owner: "0x16C4Dd5974bcEd35984850d83A21C80A5F443753",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "21587340000000000000000",
      connectorBancorReserve: "10614413962965652079682",
      connectorOriginalReserve: "26140435314087645276094",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.15",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x9a0242b7a33DAcbe40eDb927834F96eB39f8fBCB",
      symbol: "BAX",
      smartTokenSymbol: "BAXBNT",
      converterAddress: "0x6d1CEB4Fd5595c9773EB7FC79B0c090a380514DA",
      smartTokenAddress: "0xA9DE5935aE3eae8a7F943C9329940EDA160267f4",
      owner: "0x3baCda099735d0e6BCbB51E0ACC5feDcDbce6104",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "202046220630904754208",
      connectorBancorReserve: "133301054162078780857",
      connectorOriginalReserve: "878871570689273487739710",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "13"
    },
    {
      tokenAddress: "0x7B0C06043468469967DBA22d1AF33d77d44056c8",
      symbol: "MRPH",
      smartTokenSymbol: "MRPHBNT",
      converterAddress: "0x6Ea98A7e211b584d59E0d3AbA12891877b55AB17",
      smartTokenAddress: "0x4B51AcC819591c885DbA0F06d98A07b432E6D6B4",
      owner: "0x50249160741773B1FED5Aca6C7608D8ef6B50c64",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "43483512176839408076150",
      connectorBancorReserve: "48566424844696752631283",
      connectorOriginalReserve: "792956249",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 4,
      conversionFee: "0.1",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x4954Db6391F4feB5468b6B943D4935353596aEC9",
      symbol: "USDQ",
      smartTokenSymbol: "USDQBNT",
      converterAddress: "0x70e6f05ae2F61562FAb7115DdD387b83B28564de",
      smartTokenAddress: "0x9921f8F53EE185a6BFD5d9D8935107934D0B07DA",
      owner: "0x9254F1f3441ebDf8e5667b2C766EA88C7D34f3BD",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "27670980496331738485824",
      connectorBancorReserve: "24841351554814668431594",
      connectorOriginalReserve: "5597944708341076719403",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0",
      converterVersion: "11"
    },
    {
      tokenAddress: "0xc20464e0C373486d2B3335576e83a218b1618A5E",
      symbol: "DTRC",
      smartTokenSymbol: "DTRCBNT",
      converterAddress: "0x71168843b49E305E4d53dE158683903eF261B37f",
      smartTokenAddress: "0x1F593cDC35D7f0B0495dA16B631d28DE5AE25a07",
      owner: "0x0E278A8E3742A224177714fc9be001bdb7d7D2E6",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "46114000000000000000000",
      connectorBancorReserve: "22967658959757779591024",
      connectorOriginalReserve: "18621358828292376664747582",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x4AaC461C86aBfA71e9d00d9a2cde8d74E4E1aeEa",
      symbol: "ZINC",
      smartTokenSymbol: "CVTBNT",
      converterAddress: "0x72F78A5D680FCF7F62004B4c65B18A3B9AF012Ff",
      smartTokenAddress: "0x737Ac585809C0F64Ee09d7B8050d195d14f14c55",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "19043238037220905337917",
      connectorBancorReserve: "2270964358621250515654",
      connectorOriginalReserve: "168671569900224995267204",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
      symbol: "SNX(USDB)",
      smartTokenSymbol: "SNXUSDB",
      converterAddress: "0x73B9081946021Dc6B9cE3E335A11A6A5BB2879fE",
      smartTokenAddress: "0x28271853E950bE371B050F3f93aA0146225bF374",
      owner: "0xB024Fbc56AE323a05B5b6156C0FCC5001Fa5Ac9e",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "251113747823637200000",
      connectorBancorReserve: "123786266070412729033",
      connectorOriginalReserve: "122676819541246541335",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.3",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x9a005c9a89BD72a4Bd27721E7a09A3c11D2b03C4",
      symbol: "STAC",
      smartTokenSymbol: "STACBNT",
      converterAddress: "0x73f73391e5F56Ce371A61fC3e18200A73d44Cf6f",
      smartTokenAddress: "0x258D1210e9E242FDc0Ecfa3b039A51a945CD0D0a",
      owner: "0x0952cFad850C3500C131C92dda5F63c25ad7B995",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "44415992034203828335986",
      connectorBancorReserve: "1427334975824763380784",
      connectorOriginalReserve: "13437695459445539772963078",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x818Fc6C2Ec5986bc6E2CBf00939d90556aB12ce5",
      symbol: "KIN",
      smartTokenSymbol: "KINBNT",
      converterAddress: "0x7599Da2DD9e1341f4fe76133342Ae7C75FA24129",
      smartTokenAddress: "0x26b5748F9253363f95e37767e9ed7986877A4B1b",
      owner: "0x7e33009c42399F05fc4B16aeB3ACc6A60dF88058",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "136342316702823314050",
      connectorBancorReserve: "153508132966352054045",
      connectorOriginalReserve: "3683768213373321235064751",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "13"
    },
    {
      tokenAddress: "0xC5bBaE50781Be1669306b9e001EFF57a2957b09d",
      symbol: "GTO",
      smartTokenSymbol: "GTOBNT",
      converterAddress: "0x790C95EF074B77A8F92A5163cC056F163A8631e6",
      smartTokenAddress: "0xc4938292EA2d3085fFFc11C46B87CA068a83BE01",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "186276000000000000000000",
      connectorBancorReserve: "82764844160460929037784",
      connectorOriginalReserve: "216090290233",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 5,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xa704fCe7b309Ec09DF16e2F5Ab8cAf6Fe8A4BAA9",
      symbol: "AGRI",
      smartTokenSymbol: "AGRIBNT",
      converterAddress: "0x7B00EFba58CC6fdaB1c162a9C9528B935F5F1af7",
      smartTokenAddress: "0xEab935f35693c3218b927436E63564018E92034f",
      owner: "0x7075F8aeeD09c7E8E47647209B103D4ab0D763cc",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "148928650065872747129064",
      connectorBancorReserve: "77129835518767562540479",
      connectorOriginalReserve: "1328850194516351672567122",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x39Bb259F66E1C59d5ABEF88375979b4D20D98022",
      symbol: "WAX",
      smartTokenSymbol: "WAXBNT",
      converterAddress: "0x7BAc8115f3789F4d7a3BFE241EB1bCb4D7F71665",
      smartTokenAddress: "0x67563E7A0F13642068F6F999e48c690107A4571F",
      owner: "0xE53F54aeF69Ca4A1BE22ae53977F0Bf7ED10F967",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "29638610216587737969228",
      connectorBancorReserve: "18805657745194642831029",
      connectorOriginalReserve: "14076517371706",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 8,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xc72fe8e3Dd5BeF0F9f31f259399F301272eF2a2D",
      symbol: "INSTAR",
      smartTokenSymbol: "INSTAR",
      converterAddress: "0x7E4b0AbAd3407b87a381c1C05aF78d7ad42975E7",
      smartTokenAddress: "0xC803B2B2c3BA24C0C934AEB3Ba508A4dD6853F1b",
      owner: "0xae632bA07319378514BB15BdFCdc8Fa0c47e9f49",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "80847030856350797037980",
      connectorBancorReserve: "11978764314595854594611",
      connectorOriginalReserve: "605307731690989746122159",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x4162178B78D6985480A308B2190EE5517460406D",
      symbol: "CLN",
      smartTokenSymbol: "CLNBNT",
      converterAddress: "0x7eD9959754c26BdB5f101BDeA6Db32800965d0d2",
      smartTokenAddress: "0xEB027349398De19D925DefC15c4302fE92FC69f9",
      owner: "0xdfeE8DC240c6CadC2c7f7f9c257c259914dEa84E",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "10001487319409",
      connectorBancorReserve: "8106363496527",
      connectorOriginalReserve: "326050273078205",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "13"
    },
    {
      tokenAddress: "0xD46bA6D942050d489DBd938a2C909A5d5039A161",
      symbol: "AMPL",
      smartTokenSymbol: "AMPLBNT",
      converterAddress: "0x7f913E9DeeF8eFE8d09A2e67d18cEd9BE4Ad1dc7",
      smartTokenAddress: "0x0e2145A23f7810431Ba0f2e19676530b3F1Fb0EC",
      owner: "0xfe2321D7DFA492dFC39330e8b85E7c49161e7F98",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "53356000000000000020062",
      connectorBancorReserve: "16142102758186029784909",
      connectorOriginalReserve: "3502878865514",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 9,
      conversionFee: "0.1",
      converterVersion: "14"
    },
    {
      tokenAddress: "0xd559f20296FF4895da39b5bd9ADd54b442596a61",
      symbol: "FTX",
      smartTokenSymbol: "FTXBNT",
      converterAddress: "0x810C99C5De0A673E4bc86090f9bFE96a6D1B49a7",
      smartTokenAddress: "0x4d849DaD08A4061bE102DBCA2CE2718A9a0b635a",
      owner: "0x22791E66b6Cc85C2eD6709e9c8B05bF08a7139b7",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "29811721065186238380876",
      connectorBancorReserve: "25008491976651241775129",
      connectorOriginalReserve: "725968053166630970348820",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xA4e8C3Ec456107eA67d3075bF9e3DF3A75823DB0",
      symbol: "LOOM(USDB)",
      smartTokenSymbol: "LOOMUSDB",
      converterAddress: "0x81708ECf0ABB950100cd482d2843E1146fa778A4",
      smartTokenAddress: "0xc32BF4a12542E897BADbFf2B61e56c82eAe73d69",
      owner: "0x0c828DF3D331ccAb5d5676e2020592616cFaB803",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "238960717911154660000",
      connectorBancorReserve: "124464385798342400218",
      connectorOriginalReserve: "6870305590162996596191",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.15",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x6Ba460AB75Cd2c56343b3517ffeBA60748654D26",
      symbol: "UP",
      smartTokenSymbol: "UPBNT",
      converterAddress: "0x8591AFDf50093938A7f608e2f15b114dcdDd8B9A",
      smartTokenAddress: "0xd4c810fdcA379831078267f3402845E5205Aa0e1",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "90724000000000000000000",
      connectorBancorReserve: "37844231461442948498653",
      connectorOriginalReserve: "252848114789815",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 8,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x0Cf0Ee63788A0849fE5297F3407f701E122cC023",
      symbol: "DATA",
      smartTokenSymbol: "DATABNT",
      converterAddress: "0x8658863984d116d4B3A0A5af45979eceAC8a62f1",
      smartTokenAddress: "0xdD8a17169aa94E548602096EB9C9d44216cE8a37",
      owner: "0x42355e7dc0A872C465bE9DE4AcAAAcB5709Ce813",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "41456986522249920649772",
      connectorBancorReserve: "43307863565874387104436",
      connectorOriginalReserve: "603683884320129994167525",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC(USDB)",
      smartTokenSymbol: "USDCUSDB",
      converterAddress: "0x868229B43a8BCBDFfb244DDE874f52Ade0B1c132",
      smartTokenAddress: "0x71c414DaCe65ABff9351E215d25f17F675241c0A",
      owner: "0xF29C685f9f11A0634EA5bEc83fb2c47e2101FC31",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "240000000000000000000",
      connectorBancorReserve: "1200980691929762865952",
      connectorOriginalReserve: "1200355493",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 6,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xc0829421C1d260BD3cB3E0F06cfE2D52db2cE315",
      symbol: "ETH(USDB)",
      smartTokenSymbol: "ETHUSDB",
      converterAddress: "0x886f00Bc5FeB7EC1B1c18441c4DC6dcd341d0E69",
      smartTokenAddress: "0x482c31355F4f7966fFcD38eC5c9635ACAe5F4D4F",
      owner: "0x578a59bE02CcAC9eE3a5Cc26F041d2fF8424F8bA",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "27707017542075496930000",
      connectorBancorReserve: "14367843655078552435412",
      connectorOriginalReserve: "103876341726862712387",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.15",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xd26114cd6EE289AccF82350c8d8487fedB8A0C07",
      symbol: "OMG",
      smartTokenSymbol: "OMGBNT",
      converterAddress: "0x89f26Fff3F690B19057e6bEb7a82C5c29ADfe20B",
      smartTokenAddress: "0x99eBD396Ce7AA095412a4Cd1A0C959D6Fd67B340",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "235322010798203287112720",
      connectorBancorReserve: "127248972735669851718244",
      connectorOriginalReserve: "43311375829143053399695",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x3A92bD396aEf82af98EbC0Aa9030D25a23B11C6b",
      symbol: "TBX",
      smartTokenSymbol: "TBXBNT",
      converterAddress: "0x8a7bDf8388aDD5A24B357D947911bE3a07801C56",
      smartTokenAddress: "0xE844E4EF529CB1A507D47206bEeF65a921B07287",
      owner: "0x9Acf50AB22004cf09b2461C71447f1d776188fa8",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "34748000000000000000000",
      connectorBancorReserve: "8255198571315893443388",
      connectorOriginalReserve: "327419160107441509384526",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xefBd6D7deF37ffae990503EcdB1291B2f7E38788",
      symbol: "EVO",
      smartTokenSymbol: "EVOBNT",
      converterAddress: "0x8aD99BAc8cEEb7ab51837909cE0Fd243F15F75AD",
      smartTokenAddress: "0xBB8436eaf49888641Df27e4E1DfFbd4851788209",
      owner: "0x50249160741773B1FED5Aca6C7608D8ef6B50c64",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "5368763953590905815470",
      connectorBancorReserve: "914530136164713979404",
      connectorOriginalReserve: "3830882728687627661374147",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x763186eB8d4856D536eD4478302971214FEbc6A9",
      symbol: "BETR",
      smartTokenSymbol: "BETRBNT",
      converterAddress: "0x8bB76C5AE6b7D6bd1678510edD06444AcDf8F72B",
      smartTokenAddress: "0x679F601F0deb53c2dB0C8C26369FDcba5fD753CF",
      owner: "0xf726A6E821BA1cB810b7bFEfc1b818b656509613",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "2331161294961608132697141",
      connectorBancorReserve: "9671614838142485549235",
      connectorOriginalReserve: "6822707581454223323445277",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xF01d7939441a3b1B108C70A28DcD99c6A98aD4b4",
      symbol: "PRTL",
      smartTokenSymbol: "PRTLBNT",
      converterAddress: "0x8bd7448162C296A5bB3F0B9cCDEe383f5b899C93",
      smartTokenAddress: "0x2788C2dB0fBdbaee39Fa010D325d55e7e4527e0d",
      owner: "0x9254F1f3441ebDf8e5667b2C766EA88C7D34f3BD",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "26801025048398062200504",
      connectorBancorReserve: "521829541294734293213",
      connectorOriginalReserve: "259750172911005582925025",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x408e41876cCCDC0F92210600ef50372656052a38",
      symbol: "REN(USDB)",
      smartTokenSymbol: "RENUSDB",
      converterAddress: "0x8BDeeCcAF9ea6772313de36f0a1225Df137619a7",
      smartTokenAddress: "0xA807E7FAa1c2C955BD8751e2fD1cBFa289e060c6",
      owner: "0x952c23f8F067A5e7e165ff0E42491f51D87DBc95",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "220008199397586812666",
      connectorBancorReserve: "119693786203883366541",
      connectorOriginalReserve: "3327684255705431254832",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x910Dfc18D6EA3D6a7124A6F8B5458F281060fa4c",
      symbol: "X8X",
      smartTokenSymbol: "X8XBNT",
      converterAddress: "0x8C73126b85f59d85Aa61391579B4C2710DD70f96",
      smartTokenAddress: "0xAe0ceCc84bC1DDefe13C6e5B2E9D311927e45eD8",
      owner: "0x982627eBDdfF7332aa17ECB34DD959A5D5b298F3",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "43943631295726786264216",
      connectorBancorReserve: "25279819116892152271818",
      connectorOriginalReserve: "1055842026717575155628263",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x2Ef27BF41236bD859a95209e17a43Fbd26851f92",
      symbol: "MORPH",
      smartTokenSymbol: "MORPHBNT",
      converterAddress: "0x952EB7dC904F6f8b6b0Bc6c5c99d45143E743Cd7",
      smartTokenAddress: "0xB2Ea67533290fAd84e3fe2E1Fb68D21Ca062d7fc",
      owner: "0x26E62FfD197328679f13257965A134ef7778480B",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "110550237910666169393000",
      connectorBancorReserve: "3002771456412234817",
      connectorOriginalReserve: "19091325643991161",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 4,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xdd974D5C2e2928deA5F71b9825b8b646686BD200",
      symbol: "KNC(USDB)",
      smartTokenSymbol: "KNCUSDB",
      converterAddress: "0x96772082615Fb019E91877653503EB6Ef1E65Aea",
      smartTokenAddress: "0xD69AE1D715d7451646107D43777139B0a42d7c63",
      owner: "0x639cec09a3aD0DEDC2951ADB00C43a43160273c3",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "230220090792074837619",
      connectorBancorReserve: "131868510899221372036",
      connectorOriginalReserve: "530829230194190343654",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.3",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x0F5D2fB29fb7d3CFeE444a200298f468908cC942",
      symbol: "MANA",
      smartTokenSymbol: "MANABNT",
      converterAddress: "0x967f1c667fC490ddd2fb941e3a461223C03D40e9",
      smartTokenAddress: "0x79d83B390cF0EDF86B9EFbE47B556Cc6e20926aC",
      owner: "0xFE95E04A628087FCdD5f278E61F148B47471Af4A",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "78593070683782889823296",
      connectorBancorReserve: "149125662650133726211533",
      connectorOriginalReserve: "976497496115729839937755",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xB62132e35a6c13ee1EE0f84dC5d40bad8d815206",
      symbol: "NEXO(USDB)",
      smartTokenSymbol: "NEXOUSDB",
      converterAddress: "0x97Cf22539646d5a264Fb3FBb68bb0642D8AD2a66",
      smartTokenAddress: "0x515d562496C43487eb2DDce1a2A7721148D44E36",
      owner: "0x1Ea92bDc76B4bb6b8EA5F78de45f498153cE0182",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "244607214072183814015",
      connectorBancorReserve: "136348605104295412002",
      connectorOriginalReserve: "1200266085404287763778",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "1.5",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x83984d6142934bb535793A82ADB0a46EF0F66B6d",
      symbol: "REM",
      smartTokenSymbol: "REMBNT",
      converterAddress: "0x9898BB78288fE81943b806eE5DEACCF44fadB3Ff",
      smartTokenAddress: "0xaB5ae72d95d3A02796c87F8079b1E180507dF54f",
      owner: "0x69424Dc77bC69C13d5d1F3229871e2F38dB51f52",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "153403248196719952705853",
      connectorBancorReserve: "131117329618193770292876",
      connectorOriginalReserve: "77960989460",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 4,
      conversionFee: "0.1",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x84F7c44B6Fed1080f647E354D552595be2Cc602F",
      symbol: "BBO",
      smartTokenSymbol: "BBOBNT",
      converterAddress: "0x99F357f722EC3e456Af0eB530c1C14a3251305Ad",
      smartTokenAddress: "0x980B4118dAb781829DF80D7912d70B059a280DAd",
      owner: "0x1Cb417D7D5dB5EC3D3A597C1EBeE8087C2a34903",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "59815028200000000000000",
      connectorBancorReserve: "16252092216264740985",
      connectorOriginalReserve: "9331691253482171644087",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x9AF4f26941677C706cfEcf6D3379FF01bB85D5Ab",
      symbol: "DRT",
      smartTokenSymbol: "DRTBNT",
      converterAddress: "0x9b10206f236669F4f40E8e9806De9ab1813d3f65",
      smartTokenAddress: "0x904c7051D12aCE7d0107ada8702C0C759cad1672",
      owner: "0xE18cf576CDB5fc79F9f47f6d733eFe3EF2fae907",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "35176000000000000000000",
      connectorBancorReserve: "11933447473333106796638",
      connectorOriginalReserve: "370810264169059",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 8,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x5d60d8d7eF6d37E16EBABc324de3bE57f135e0BC",
      symbol: "MYB",
      smartTokenSymbol: "MYBBNT",
      converterAddress: "0x9dB89726aE2683d21A71fF1417638E72e6D8C0d9",
      smartTokenAddress: "0xf22FB05aC032fcAf3273f50aF8db2753888Bdd48",
      owner: "0x915F4F6FeA3a9b68cAe159017eB594Cb53aF99B4",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "139710000000000000000000",
      connectorBancorReserve: "25847088073487915395021",
      connectorOriginalReserve: "11998888344892856279570979",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x744d70FDBE2Ba4CF95131626614a1763DF805B9E",
      symbol: "SNT",
      smartTokenSymbol: "SNTBNT",
      converterAddress: "0x9dCe7C9767863110E4fA01410A35b5471AecE64e",
      smartTokenAddress: "0xa3b3c5a8b22C044D5f2d372f628245E2106D310D",
      owner: "0xC7A965dCec421B8423De2d7b26EB83AAC8070aCC",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "66084474979503534365456",
      connectorBancorReserve: "42749844498051036530173",
      connectorOriginalReserve: "1009453671487730772954106",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "13"
    },
    {
      tokenAddress: "0xF629cBd94d3791C9250152BD8dfBDF380E2a3B9c",
      symbol: "ENJ",
      smartTokenSymbol: "ENJBNT",
      converterAddress: "0x9e8f95969aB023c36541Bc089e25D50C6fCF0811",
      smartTokenAddress: "0xf3aD2cBc4276eb4B0fb627Af0059CfcE094E20a1",
      owner: "0xdE63aef60307655405835DA74BA02CE4dB1a42Fb",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "8388815379339112051468066",
      connectorBancorReserve: "343483564405588300844274",
      connectorOriginalReserve: "1030181340887290270200472",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x009e864923b49263c7F10D19B7f8Ab7a9A5AAd33",
      symbol: "FKX",
      smartTokenSymbol: "FKXBNT",
      converterAddress: "0x9F547E89078B24d0e2269Ba08EB411102E98CA14",
      smartTokenAddress: "0x80c222E38fb57F0710aF21128535096D90503285",
      owner: "0x7E90401BbcB43DC459eF1e35f43d1F12a1d8404D",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "107098994901810345036752",
      connectorBancorReserve: "39752573802449472993738",
      connectorOriginalReserve: "3951942276102204730913957",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x2dAEE1AA61D60A252DC80564499A69802853583A",
      symbol: "ATS",
      smartTokenSymbol: "ATSBNT",
      converterAddress: "0xa00655976c5c9A1eD58b3707b190867069bAbEe5",
      smartTokenAddress: "0x1D75ebc72f4805e9C9918B36A8969b2e3847c9FB",
      owner: "0x600a65F8246FB0237bCf344D33b2c15F8F673941",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "63921728304626929127596",
      connectorBancorReserve: "757068431538378881426",
      connectorOriginalReserve: "25966283942",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 4,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x960b236A07cf122663c4303350609A66A7B288C0",
      symbol: "ANT",
      smartTokenSymbol: "ANTBNT",
      converterAddress: "0xA0dc0Aa8Ff89A74C9E5EDCB008788B201405683c",
      smartTokenAddress: "0x0c485BffD5df019F66927B2C32360159884D4409",
      owner: "0xb6e9A5aEDEe5DDB5407DF1c550466d18ba3b08E1",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "101987959959959959960089",
      connectorBancorReserve: "110521847350034801423052",
      connectorOriginalReserve: "43678944733247241743556",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.5",
      converterVersion: "11"
    },
    {
      tokenAddress: "0xe3818504c1B32bF1557b16C238B2E01Fd3149C17",
      symbol: "PLR",
      smartTokenSymbol: "PLRBNT",
      converterAddress: "0xA260306FE5E57caE7BdCC7ff0488061EACE32b58",
      smartTokenAddress: "0x2843F6c3b14e698e3D7562584959C61274F93328",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "86243959178489864060000",
      connectorBancorReserve: "46681583961891456872721",
      connectorOriginalReserve: "454302856467938970107485",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359",
      symbol: "DAI",
      smartTokenSymbol: "DAIBNT",
      converterAddress: "0xA2cAF0d7495360CFa58DeC48FaF6B4977cA3DF93",
      smartTokenAddress: "0xee01b3AB5F6728adc137Be101d99c678938E6E72",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "93925005049968938933490",
      connectorBancorReserve: "378253757632374515155859",
      connectorOriginalReserve: "82898117909945415432180",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.2",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x607F4C5BB672230e8672085532f7e901544a7375",
      symbol: "RLC",
      smartTokenSymbol: "RLCBNT",
      converterAddress: "0xA5Ee22C4Ec7e4c0f2B037147697Dde1FB79Aa6fB",
      smartTokenAddress: "0x9003411Ac4073C2D9f37af71d00E373B72Cbe9E2",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "38780357083133059356954",
      connectorBancorReserve: "70309583310739613503993",
      connectorOriginalReserve: "35036992163871",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 9,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x627974847450C45b60B3Fe3598f4e6E4cf945B9a",
      symbol: "TBC(USDB)",
      smartTokenSymbol: "TBCUSDB",
      converterAddress: "0xa6Bc8b07507bbEB13e21B82067a07802da8aEFBF",
      smartTokenAddress: "0x323e4d8097B0A58aB8210AC6efCC4a89285cFc6B",
      owner: "0x44FF90C9187F1A1dcE978E7bCB714505BBf23D76",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "111000000000000000000",
      connectorBancorReserve: "27805472250000000000",
      connectorOriginalReserve: "100909090909090909090911",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xA207Ef81C35848A60A732005A42fAe0BA89A9bE2",
      symbol: "MGT",
      smartTokenSymbol: "MGTBNT",
      converterAddress: "0xabD0dDC9143972E4eA9A816821bfba8204122E6E",
      smartTokenAddress: "0x0bA204702F102aD3B0156164754e8af18C24C49C",
      owner: "0x7A70bB2536C4B3558717A8d60a0d2886bB34616C",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "3987916989264340500",
      connectorBancorReserve: "2513416185865116528",
      connectorOriginalReserve: "3970",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 4,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x5B09A0371C1DA44A8E24D36Bf5DEb1141a84d875",
      symbol: "MAD",
      smartTokenSymbol: "MADBNT",
      converterAddress: "0xACC03E1fD72CddC66C736cCe84626fbc63dd953B",
      smartTokenAddress: "0x014186b1a2d675fc1e303A3d62B574C3270A38e0",
      owner: "0xBb124036c5A3F8aAFDc7Df6FA412Ab0662C8f91a",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "160887520291069827586000",
      connectorBancorReserve: "50888627184254219680364",
      connectorOriginalReserve: "2058273833108375794823399",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xf8e386EDa857484f5a12e4B5DAa9984E06E73705",
      symbol: "IND",
      smartTokenSymbol: "INDBNT",
      converterAddress: "0xB018AF916Ed0116404537D1238b18988D652733a",
      smartTokenAddress: "0x32423158e8FBD2839E085626F8a98D86b2766De8",
      owner: "0xA53a22FCa7ffe3762dCd2A8ABC332ede24B5AA2D",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "37005256663767539697372",
      connectorBancorReserve: "12567659400815961295829",
      connectorOriginalReserve: "1079671652228593135557792",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xD97E471695f73d8186dEABc1AB5B8765e667Cd96",
      symbol: "EMCO",
      smartTokenSymbol: "EMCOBNT",
      converterAddress: "0xB117b0216e247AF88e13b0D6a0c2a08463f01FC7",
      smartTokenAddress: "0x9FD952F675F14157b988590516c67045FaF20743",
      owner: "0x9Bd0699fAcac3D7Ca884A4eb58B796E1361Ab111",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "848031280715632252",
      connectorBancorReserve: "396168838826651398",
      connectorOriginalReserve: "491418240676750686",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x08711D3B02C8758F2FB3ab4e80228418a7F8e39c",
      symbol: "EDG",
      smartTokenSymbol: "EDGBNT",
      converterAddress: "0xB2ecD60764A3A800358BB252976bD57C05554b71",
      smartTokenAddress: "0xf95dd0Fc6DF64b2F149aFA9219579e0f850BCD4D",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "24230000020730942400358",
      connectorBancorReserve: "5697692600725219296374",
      connectorOriginalReserve: "155326",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 0,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x86D17e2eF332293391303F188F6a467dc0D1fd0d",
      symbol: "RST100",
      smartTokenSymbol: "RSTBNT",
      converterAddress: "0xb61b3FE730Fb58936f06239feA2FEEd5B3256F50",
      smartTokenAddress: "0x43d3a0712eD544b26d85c9eaf841008369bAB5d1",
      owner: "0x9254F1f3441ebDf8e5667b2C766EA88C7D34f3BD",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "239578586486197530055442",
      connectorBancorReserve: "8756683945011890457444",
      connectorOriginalReserve: "11053868781594229450263",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0",
      converterVersion: "11"
    },
    {
      tokenAddress: "0xDF2C7238198Ad8B389666574f2d8bc411A4b7428",
      symbol: "MFT",
      smartTokenSymbol: "MFTBNT",
      converterAddress: "0xB622B86A65d2FBD5d7F28803dC6e5C9810F6a746",
      smartTokenAddress: "0x4319f9130848544afB97e92cb3Ea9fdb4b0A0B2a",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "194800000000000000000000",
      connectorBancorReserve: "79889735536970924053608",
      connectorOriginalReserve: "21316083060081807885387612",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x255Aa6DF07540Cb5d3d297f0D0D4D84cb52bc8e6",
      symbol: "RDN",
      smartTokenSymbol: "RDNBNT",
      converterAddress: "0xB7246144F53Ec44E0f845Fd0DEea85208acFC2C9",
      smartTokenAddress: "0x11223Ed5D5846603C4EfC7c451FD8EB596d592cF",
      owner: "0xE761aA1e8aBffcE23236D13D8F0a532E57bc1457",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "102075883104556984719528",
      connectorBancorReserve: "62560138178514002450253",
      connectorOriginalReserve: "123878122835688937830065",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.5",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x37E8789bB9996CaC9156cD5F5Fd32599E6b91289",
      symbol: "AID",
      smartTokenSymbol: "AIDBNT",
      converterAddress: "0xb85E52268CBF57b97Ae15136Aa65D4F567B8107c",
      smartTokenAddress: "0xe3BF775Ec5f4F4dFCbb21194B22be1217b815b1d",
      owner: "0x8956f1D18670B7f9dE60Bb2CAE71806F0C7e0A01",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "38401286811528004694186",
      connectorBancorReserve: "16785584123626346275787",
      connectorOriginalReserve: "524908707056337109539807",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x1063ce524265d5a3A624f4914acd573dD89ce988",
      symbol: "AIX",
      smartTokenSymbol: "AIXBNT",
      converterAddress: "0xb8a6920962655c97F0E3Eab40E5706Ed934907Cc",
      smartTokenAddress: "0xA415cD56C694bd7402d14560D18Bb19A28F77617",
      owner: "0x4Cbb51Ee8611d45FedC37D99D0E05c7D1fC2c49D",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "15284755394631549809087",
      connectorBancorReserve: "660017236196198705635",
      connectorOriginalReserve: "520066722542315460051450",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x28dee01D53FED0Edf5f6E310BF8Ef9311513Ae40",
      symbol: "XBP",
      smartTokenSymbol: "XBPBNT",
      converterAddress: "0xBA2BE1Cd1F00470c21385B7cbED6211aeFAc0172",
      smartTokenAddress: "0xbb83a9Fe991BAA72F412F39af254EEbbfdc910BA",
      owner: "0x9cE04b2e6d9d7c4BA1f4053a9888D660D83e4b7D",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "51077281545158970491142",
      connectorBancorReserve: "27448011111345073321024",
      connectorOriginalReserve: "24247283179373055070951663",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x7C5A0CE9267ED19B22F8cae653F198e3E8daf098",
      symbol: "SAN",
      smartTokenSymbol: "SANBNT",
      converterAddress: "0xBAC94DC2411F494c438cA667A4836e3DCCAA4920",
      smartTokenAddress: "0xd6A6c879Ad8c01D0C8d5bF1C85829814b954DBBF",
      owner: "0x1F3dF0b8390BB8e9e322972C5e75583E87608Ec2",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "53912356294544136597085",
      connectorBancorReserve: "69460180359625343134142",
      connectorOriginalReserve: "72960433742043225520154",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "11"
    },
    {
      tokenAddress: "0xb0280743b44bF7db4B6bE482b2Ba7b75E5dA096C",
      symbol: "TNS",
      smartTokenSymbol: "TNSBNT",
      converterAddress: "0xbC9149E33214C495F525F111DD45c773633Aac02",
      smartTokenAddress: "0x5cf2f6387c4F551316e1E422aCf1025a539825c3",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "45375005443695364832302",
      connectorBancorReserve: "5702035112381159822802",
      connectorOriginalReserve: "937796046129326896909948",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x0D8775F648430679A709E98d2b0Cb6250d2887EF",
      symbol: "BAT",
      smartTokenSymbol: "BATBNT",
      converterAddress: "0xBd19F30adDE367Fe06c0076D690d434bF945A8Fc",
      smartTokenAddress: "0x131da075a2832549128e93AcC2b54174045232Cf",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "187242465829869294623992",
      connectorBancorReserve: "395495317565761726515635",
      connectorOriginalReserve: "464085128038271131265242",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x3166C570935a7D8554c8f4eA792ff965D2EFe1f2",
      symbol: "QDAO",
      smartTokenSymbol: "QDAOBNT",
      converterAddress: "0xbDC7310289dCd30D16E284d6F207a8E2F76A37aD",
      smartTokenAddress: "0x19683E94943E6b348D8AFB98C128B9b549B400DF",
      owner: "0x9254F1f3441ebDf8e5667b2C766EA88C7D34f3BD",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "27783706580183414382638",
      connectorBancorReserve: "13771319179621692607551",
      connectorOriginalReserve: "192772611622051777189",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x2C974B2d0BA1716E644c1FC59982a89DDD2fF724",
      symbol: "VIB",
      smartTokenSymbol: "VIBBNT",
      converterAddress: "0xbE1DAF05Bf9e054b3e28b7E9C318819eF5dAcb58",
      smartTokenAddress: "0x2948BD241243Bb6924A0b2f368233DDa525AAB05",
      owner: "0x4679e51eDC6998ccFf619874f5B0a8B522fF4220",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "180802088539980000000000",
      connectorBancorReserve: "129814382181740309871161",
      connectorOriginalReserve: "1464050383379615437880141",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x419c4dB4B9e25d6Db2AD9691ccb832C8D9fDA05E",
      symbol: "DRGN",
      smartTokenSymbol: "DRGNBNT",
      converterAddress: "0xBfc4933f5180589EF76DAc288b1fFc4A0d11884a",
      smartTokenAddress: "0xa7774F9386E1653645E1A08fb7Aae525B4DeDb24",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "89201088693227960652696",
      connectorBancorReserve: "31156744327505220872782",
      connectorOriginalReserve: "197213317684746725049790",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xaAAf91D9b90dF800Df4F55c205fd6989c977E73a",
      symbol: "TKN",
      smartTokenSymbol: "TKNBNT",
      converterAddress: "0xC04B5a4556d00Bca8eac5F5accA31981a6597409",
      smartTokenAddress: "0x497Ec0D6Ba2080f0ed7ecf7a79a2A907401b3239",
      owner: "0x0eb1afd80aEc9e991c5F8D95A421bE187974912F",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "145129031808753522136591",
      connectorBancorReserve: "163963597638967921512234",
      connectorOriginalReserve: "15252344451903",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 8,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xF6B55acBBC49f4524Aa48D19281A9A77c54DE10f",
      symbol: "WLK",
      smartTokenSymbol: "WLKBNT",
      converterAddress: "0xc11CcE040583640001f5a7E945DFd82f662cC0aE",
      smartTokenAddress: "0xd387CDAF85429b455f0F716D51Be33db2FC00463",
      owner: "0x34c7fC051eAe78F8C37B82387a50a5458b8F7018",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "28714459286595063931445",
      connectorBancorReserve: "4248193593194764318278",
      connectorOriginalReserve: "351707796606065788144666",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x627974847450C45b60B3Fe3598f4e6E4cf945B9a",
      symbol: "TBC",
      smartTokenSymbol: "TBCBNT",
      converterAddress: "0xc289FFB78aB59109A9D24E2B5e63cD66C0369fdb",
      smartTokenAddress: "0xb13819374575Be7Ced2b0896c645612164ebE772",
      owner: "0x44FF90C9187F1A1dcE978E7bCB714505BBf23D76",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "0",
      connectorBancorReserve: "0",
      connectorOriginalReserve: "0",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.101",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x1776e1F26f98b1A5dF9cD347953a26dd3Cb46671",
      symbol: "NMR(USDB)",
      smartTokenSymbol: "NMRUSDB",
      converterAddress: "0xc3b1928A01aC03F8353d05196AfcA778ab9970f7",
      smartTokenAddress: "0xEfec901ff0a33d0eF4f8068CDd8b28Fdc40aa556",
      owner: "0xb6Dfd981D9Dee4AFBE498f3d7445462fB8E5157f",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "219998651854727340000",
      connectorBancorReserve: "109999325927363675650",
      connectorOriginalReserve: "17025753622488854013",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x57Ab1ec28D129707052df4dF418D58a2D46d5f51",
      symbol: "sUSD(USDB)",
      smartTokenSymbol: "sUSDUSDB",
      converterAddress: "0xc89bC9cBB8237C58587b5F907ed6B3163BFDD1B9",
      smartTokenAddress: "0x9B6678c766003aD69A15f795f433C0F62c10D4d5",
      owner: "0x43963E218DCdb78D8c23F74824f1298F2d748395",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "15007078650409932706101",
      connectorBancorReserve: "75443803094160663560574",
      connectorOriginalReserve: "76034681371151284042941",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xF970b8E36e23F7fC3FD752EeA86f8Be8D83375A6",
      symbol: "RCN",
      smartTokenSymbol: "RCNBNT",
      converterAddress: "0xcBc2fa314A33ae52fc29e0144D4A7747a532E0dc",
      smartTokenAddress: "0xf7b9fa01098f22527Db205Ff9BB6FdF7C7D9F1C5",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "112582648471498466029486",
      connectorBancorReserve: "161766664836707709842779",
      connectorOriginalReserve: "857678598022867594863367",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xd7631787B4dCc87b1254cfd1e5cE48e96823dEe8",
      symbol: "SCL",
      smartTokenSymbol: "SCLBNT",
      converterAddress: "0xd361339550CD8B3e9446Bbb12AEA337785A7aea4",
      smartTokenAddress: "0xFcEb45cF070B277fedE520c5539ae204Bc1D493E",
      owner: "0x4712Ac736C91890D237Eacd1B2Ad51ebD7cd87A5",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "41001000036480056069513",
      connectorBancorReserve: "14127457475650127050211",
      connectorOriginalReserve: "64955447546381",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 8,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xc0829421C1d260BD3cB3E0F06cfE2D52db2cE315",
      symbol: "ETH",
      smartTokenSymbol: "ETHBNT",
      converterAddress: "0xd3ec78814966Ca1Eb4c923aF4Da86BF7e6c743bA",
      smartTokenAddress: "0xb1CD6e4153B2a390Cf00A6556b0fC1458C4A5533",
      owner: "0xdfeE8DC240c6CadC2c7f7f9c257c259914dEa84E",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "13836827628653886422701237",
      connectorBancorReserve: "8001364247376148674611258",
      connectorOriginalReserve: "12684569197736367757569",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "28"
    },
    {
      tokenAddress: "0x0D8775F648430679A709E98d2b0Cb6250d2887EF",
      symbol: "BAT(USDB)",
      smartTokenSymbol: "BATUSDB",
      converterAddress: "0xD6DD7d29EcAB65D092942d42c4F360Fde41693Dc",
      smartTokenAddress: "0x7FfE011B93e06FA14CE5A6E00320937652664366",
      owner: "0xa101A90968e17C77D2b39ecff68eCAD7c6012997",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "232812545191794200000",
      connectorBancorReserve: "121741557743994434334",
      connectorOriginalReserve: "670260367767712327560",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.3",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xCb94be6f13A1182E4A4B6140cb7bf2025d28e41B",
      symbol: "TRST",
      smartTokenSymbol: "TRSTBNT",
      converterAddress: "0xdA764901E0A424A3356633D592a179de65E310fe",
      smartTokenAddress: "0x064432E84F05094E3eD746A35ab9B7aB865fDa5C",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "21708462817254254045764",
      connectorBancorReserve: "9218644300466118214074",
      connectorOriginalReserve: "154596753820",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 6,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x595832F8FC6BF59c85C527fEC3740A1b7a361269",
      symbol: "POWR(USDB)",
      smartTokenSymbol: "POWRUSDB",
      converterAddress: "0xDB3eC1d6A089F6be97B8fc00bEB43b34c7BeEB23",
      smartTokenAddress: "0x8bb91B280A39A9e9D8505B9a5BC792CCb3B9779E",
      owner: "0xb941c7aAd899B5F7a575A566C85f5132C8A9E4aa",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "100000000000000000000",
      connectorBancorReserve: "400000000000000000",
      connectorOriginalReserve: "1000000",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 6,
      conversionFee: "0",
      converterVersion: "22"
    },
    {
      tokenAddress: "0xE7775A6e9Bcf904eb39DA2b68c5efb4F9360e08C",
      symbol: "TAAS",
      smartTokenSymbol: "TAASBNT",
      converterAddress: "0xDB9272880400e0AE8e522994f6a959122D94C7B7",
      smartTokenAddress: "0xAE201360282C885bf3F2616A3145D1344a1e43c0",
      owner: "0x17d751d6B8254F02A0d03C5b426F6a4b96C6D801",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "32947226728832673740864",
      connectorBancorReserve: "28666993185294289213392",
      connectorOriginalReserve: "12506295833",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 6,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x5e3346444010135322268a4630d2ED5F8D09446c",
      symbol: "LOC",
      smartTokenSymbol: "LOCBNT",
      converterAddress: "0xDbA193795E33B445b8c215252B0055a58Db4F0af",
      smartTokenAddress: "0x38838B895cbf02048455Fb7f649D97C564fC18a8",
      owner: "0x5f319faA141863033b38647C88C266b86f7DbF32",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "590255282263088775797106",
      connectorBancorReserve: "340196824168642798422532",
      connectorOriginalReserve: "167311229367456773496049",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "1",
      converterVersion: "23"
    },
    {
      tokenAddress: "0x9c23D67AEA7B95D80942e3836BCDF7E708A747C2",
      symbol: "LOCI",
      smartTokenSymbol: "LOCIBNT",
      converterAddress: "0xdc59242010E2d29617Bfeec57E62c7C00a5ACb52",
      smartTokenAddress: "0x6feb9Be6c40A12276cFa6DAFbD119ea62532daaB",
      owner: "0xf41030c5ACaE65C7d8f53F8134c466F6E8851492",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "108866517272665779539884",
      connectorBancorReserve: "17249809313398652905097",
      connectorOriginalReserve: "6232456469881561016295494",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xD0a4b8946Cb52f0661273bfbC6fD0E0C75Fc6433",
      symbol: "STORM",
      smartTokenSymbol: "STORMBNT",
      converterAddress: "0xdD7DE51c4F6FAF10Afce495f1Ef02E5Baa91379c",
      smartTokenAddress: "0xCad4da66E00FDeCaBeC137a24E12Af8eDF303a1d",
      owner: "0xb6bf1b11b1D12D75eA1B9848543E22f6a974AcAd",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "20394133844393775909",
      connectorBancorReserve: "18728676516225465933",
      connectorOriginalReserve: "3745514111554100527805",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "11"
    },
    {
      tokenAddress: "0x4CEdA7906a5Ed2179785Cd3A40A69ee8bc99C466",
      symbol: "AION",
      smartTokenSymbol: "AIONBNT",
      converterAddress: "0xdd9B82c59aa260B2A834Ec67C472f43b40a2E6f1",
      smartTokenAddress: "0x73fa2B855be96AB3C73f375B8Ec777226eFA3845",
      owner: "0xF8e44616746AcabD3393346D7A4d09650572F74b",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "103114000000000000000000",
      connectorBancorReserve: "242811471360495128",
      connectorOriginalReserve: "72772638",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 8,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C",
      symbol: "BNT",
      smartTokenSymbol: "BNTUSD",
      converterAddress: "0xDdA1BFaF552b0F303d27853a4a13Dd440C7E849f",
      smartTokenAddress: "0x607108c46bCE4cF6f86698E9B46E3270A734FeFe",
      owner: "0x734C2afF51c4589E6310E0c0ac7D84D244c6Ce1A",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "617000000000000000000000",
      connectorBancorReserve: "7352683437331198104962",
      connectorOriginalReserve: "27696303023519557057837",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.3",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x595832F8FC6BF59c85C527fEC3740A1b7a361269",
      symbol: "POWR",
      smartTokenSymbol: "POWRBNT",
      converterAddress: "0xDFe1582f156b3D2b8346714E9f94574a8448e27c",
      smartTokenAddress: "0x168D7Bbf38E17941173a352f1352DF91a7771dF3",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "133912060723431734581319",
      connectorBancorReserve: "101627922575569600642376",
      connectorOriginalReserve: "612546237975",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 6,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C",
      symbol: "BNT(USDB)",
      smartTokenSymbol: "USDBBNT",
      converterAddress: "0xE03374cAcf4600F56BDDbDC82c07b375f318fc5C",
      smartTokenAddress: "0xd1146B08e8104EeDBa44a73B7bda1d102c6ceDC9",
      owner: "0x68d6aC0Aedf140e18058E3d848B199D09D3a6310",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "84758823891757365565699",
      connectorBancorReserve: "20135304910036076324764",
      connectorOriginalReserve: "90770622373213752578337",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.15",
      converterVersion: "14"
    },
    {
      tokenAddress: "0x1985365e9f78359a9B6AD760e32412f4a445E862",
      symbol: "REP(USDB)",
      smartTokenSymbol: "REPUSDB",
      converterAddress: "0xe037d37898E6f6fFE8AcE3Eb93cD0F78FF107A8e",
      smartTokenAddress: "0xAb0C9850BaACF24eFA368b57C2822Ce73b60794c",
      owner: "0x43963E218DCdb78D8c23F74824f1298F2d748395",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "210000000000000000000",
      connectorBancorReserve: "103521615119145629795",
      connectorOriginalReserve: "10922277911862806482",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x26E75307Fc0C021472fEb8F727839531F112f317",
      symbol: "C20",
      smartTokenSymbol: "C20BNT",
      converterAddress: "0xE04c8aecb58BC3C918aeDAc958224a632529926e",
      smartTokenAddress: "0x1EF9e0ac29b3813528FbfdAdf5118AB63e4be015",
      owner: "0x5972A242B1852b5a76eF78Fc925dbc66fb836E95",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "414216383418091396748",
      connectorBancorReserve: "240118297852544395497",
      connectorOriginalReserve: "145406557494442307173",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.5",
      converterVersion: "13"
    },
    {
      tokenAddress: "0xF433089366899D83a9f26A773D59ec7eCF30355e",
      symbol: "MTL",
      smartTokenSymbol: "MTLBNT",
      converterAddress: "0xE0569fd1C3f0affD7E08131A16C06f3381C9355a",
      smartTokenAddress: "0x60Be88DD72f03C91FB22EEF7Af24C2e99Db58530",
      owner: "0x0040C769b501805c6Ebd77E3e2c64073Fe4EbD69",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "66950160000000000000000",
      connectorBancorReserve: "60556912178468170840767",
      connectorOriginalReserve: "5967995193933",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 8,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x3C45B24359fB0E107a4eAA56Bd0F2cE66C99A0E5",
      symbol: "ANK",
      smartTokenSymbol: "ANKBNT",
      converterAddress: "0xE1437F404451A00A9C555000b6f3cBA2480291c8",
      smartTokenAddress: "0x437F7d93540094Da58F337644ba7D6E5Ad823564",
      owner: "0x6884249C226F1443f2b7040A3d6143C170Df34F6",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "655615854025015532",
      connectorBancorReserve: "227938518106151249",
      connectorOriginalReserve: "52016899790473029865689",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x4D305c2334c02E44aC592BbEA681bA4cC1576DE3",
      symbol: "REPUX",
      smartTokenSymbol: "REPUXBNT",
      converterAddress: "0xe27cf7324E6377bdDc48DB6BAC642839ffa9Bb36",
      smartTokenAddress: "0x28291d74Bca9dE7cb6948A8E699651ed93832c50",
      owner: "0x8CaE32C636385A14b4E0A0e68a760FaCfabBCd9c",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "38859159383694539968195",
      connectorBancorReserve: "120025266214417130566",
      connectorOriginalReserve: "48822488102841082688516",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xb056c38f6b7Dc4064367403E26424CD2c60655e1",
      symbol: "CEEK(USDB)",
      smartTokenSymbol: "CEEKUSDB",
      converterAddress: "0xE2AE92c64bfEFeC1Ef884071a7E7857d285c18D7",
      smartTokenAddress: "0x27b099CF19227Ef7488D60a441d7eA2CC7FDDb25",
      owner: "0xb941c7aAd899B5F7a575A566C85f5132C8A9E4aa",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "1000000000000000000000",
      connectorBancorReserve: "1000000000000000000",
      connectorOriginalReserve: "1000000000000000000",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "22"
    },
    {
      tokenAddress: "0xd26114cd6EE289AccF82350c8d8487fedB8A0C07",
      symbol: "OMG(USDB)",
      smartTokenSymbol: "OMGUSDB",
      converterAddress: "0xE638A52dDAd3fa31233152C17422E3312A3f6643",
      smartTokenAddress: "0xAeBfeA5ce20af9fA2c65fb62863b31A90b7e056b",
      owner: "0xB024Fbc56AE323a05B5b6156C0FCC5001Fa5Ac9e",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "284279063628729461218",
      connectorBancorReserve: "144531781474697226960",
      connectorOriginalReserve: "215583760854508133537",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.3",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xcbee6459728019CB1f2bB971dDe2eE3271BC7617",
      symbol: "MRG",
      smartTokenSymbol: "MRGBNT",
      converterAddress: "0xE65c7e27C1c086f26CE0Daa986C3d9c24Ef3c2D8",
      smartTokenAddress: "0x25Bf8913D6296a69C7B43BC781614992cb218935",
      owner: "0xFb016E01421e26C643c4Ca5e8A6dCC3030597761",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "57200000000000000000000",
      connectorBancorReserve: "18551684181032389740529",
      connectorOriginalReserve: "15349728576757851705889660",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x5E8f0e658aff673AA635a889c5b4F38f12E2A740",
      symbol: "EGX",
      smartTokenSymbol: "EGXBNT",
      converterAddress: "0xeDD1b505BAe327a3028eF5BCffcbD1F34a75891E",
      smartTokenAddress: "0xfB834a1515cbC7f8B04D7Ab4Bd27D6922bee1A93",
      owner: "0xA8ae7dcDE1EcA8F3bf1537f01af5c6c547F924C4",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "154164000000000000000000",
      connectorBancorReserve: "59142727462045668947701",
      connectorOriginalReserve: "77000003188831633365",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "14"
    },
    {
      tokenAddress: "0xF629cBd94d3791C9250152BD8dfBDF380E2a3B9c",
      symbol: "ENJ(USDB)",
      smartTokenSymbol: "ENJUSDB",
      converterAddress: "0xF02182DA935b810CDD3B5c92F324C16FC0413c3B",
      smartTokenAddress: "0x42529f410f0a72599Fff2c67DD2a63CFfBcc3f91",
      owner: "0x41f57A9C25d6f9607b85fAc6FE778c265d8575f6",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "246254213087143339519",
      connectorBancorReserve: "133900728366134190864",
      connectorOriginalReserve: "1571949922562303601588",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.4",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xe245286c988eBf5099287749453CF19273436C04",
      symbol: "GRIG",
      smartTokenSymbol: "GRIGBNT",
      converterAddress: "0xf1e5267A747a6504BC93b88556F57EB02f742451",
      smartTokenAddress: "0x912D734C351425Ca35f22Ab7E16524147628E61c",
      owner: "0x7092614d09761703Cf6c251cc0Ba94D281C6c86C",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "328060860275441100000",
      connectorBancorReserve: "164030430137720540000",
      connectorOriginalReserve: "1000",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 2,
      conversionFee: "0.5",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x0D262e5dC4A06a0F1c90cE79C7a60C09DfC884E4",
      symbol: "J8T",
      smartTokenSymbol: "J8TBNT",
      converterAddress: "0xf42305EA9d1527211EdA8Fb333FBf2668BFfd9E1",
      smartTokenAddress: "0x8E00BacD7d8265d8F3f9d5B4fbd7F6B0B0c46f36",
      owner: "0x4c5EAc70432341Cc7d4334ce811f7dA9bBb7FA2e",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "137904000000000000000000",
      connectorBancorReserve: "49901636447460988026184",
      connectorOriginalReserve: "3809443389796905",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 8,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xE41d2489571d322189246DaFA5ebDe1F4699F498",
      symbol: "ZRX(USDB)",
      smartTokenSymbol: "ZRXUSDB",
      converterAddress: "0xF4736618F2782b662304b7340084a6Bc6DDb5C2c",
      smartTokenAddress: "0x1a3c6768e200482F5f47D1BE77B7255aBCAe4Fe2",
      owner: "0xC4221c0339479a36Ccc7A4d6E279353b18E40165",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "USDB",
      smartTokenSupply: "410478710795265578040",
      connectorBancorReserve: "200850467068863268338",
      connectorOriginalReserve: "1076881585486439886404",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "2.5",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x667088b212ce3d06a1b553a7221E1fD19000d9aF",
      symbol: "WINGS",
      smartTokenSymbol: "WINGSBNT",
      converterAddress: "0xF5185Ee048aE4FB3E8db4E1CcaA4E847Cd382d5A",
      smartTokenAddress: "0xA6Ab3c8aE51962f4582db841dE6b0A092041461e",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "46445387080415483185490",
      connectorBancorReserve: "19081130265407497805973",
      connectorOriginalReserve: "200743817416983337287137",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x8f8221aFbB33998d8584A2B05749bA73c37a938a",
      symbol: "REQ",
      smartTokenSymbol: "REQBNT",
      converterAddress: "0xf55C7d64703e879F279bb65B47b65B3D450130bc",
      smartTokenAddress: "0xccB5E3Ba5356D57001976092795626ac3b87Ad4e",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "150414000000000000000000",
      connectorBancorReserve: "80592247966714388367090",
      connectorOriginalReserve: "1708999882776448065405008",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0xEa1f346faF023F974Eb5adaf088BbCdf02d761F4",
      symbol: "TIX",
      smartTokenSymbol: "TIXBNT",
      converterAddress: "0xf9Ae1a94e3a6a3C24377f5A81FC1cfce78BCBd6C",
      smartTokenAddress: "0x324c703DD2F03960600F3036955488A55885B527",
      owner: "0x50249160741773B1FED5Aca6C7608D8ef6B50c64",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "94101903756941348803501",
      connectorBancorReserve: "700000000000000000",
      connectorOriginalReserve: "601581000000000000000000",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "32"
    },
    {
      tokenAddress: "0x6758B7d441a9739b98552B373703d8d3d14f9e62",
      symbol: "POA20",
      smartTokenSymbol: "POABNT",
      converterAddress: "0xFA15985038633F5497EB4554B4224aD8510179e2",
      smartTokenAddress: "0x564c07255AFe5050D82c8816F78dA13f2B17ac6D",
      owner: "0x20412bD6d146309c55cC607d30c5aAd07fbF6148",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "390062000000000000000392",
      connectorBancorReserve: "120924079398411791420584",
      connectorOriginalReserve: "2399195038451056129527221",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "20"
    },
    {
      tokenAddress: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
      symbol: "MKR",
      smartTokenSymbol: "MKRBNT",
      converterAddress: "0xfdbb3b3Cfd6fcc0DD5C1B5bff05bFfAC1DB42258",
      smartTokenAddress: "0xf553E6eA4CE2F7dEEcbe7837E27931850eC15faB",
      owner: "0xE693cD414421237E3a6C613a0C75d41dD1921b61",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "210120525438902427989189",
      connectorBancorReserve: "162572238271897960945648",
      connectorOriginalReserve: "75272457787408356341",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.5",
      converterVersion: "32"
    },
    {
      tokenAddress: "0xd341d1680Eeee3255b8C4c75bCCE7EB57f144dAe",
      symbol: "ONG",
      smartTokenSymbol: "ONGBNT",
      converterAddress: "0xFE62e9d7C7781936499eAAe20fBf3671B641516D",
      smartTokenAddress: "0x8104E7ce81FaB39c42e34Cd9d8B654135261Fae8",
      owner: "0xe727B18E8d4EC97C508e46baA5b0d59d80A3429f",
      isOfficial: 1,
      isCoTraderVerified: 0,
      isBlacklisted: 0,
      connectorType: "BNT",
      smartTokenSupply: "38901482541630736405433",
      connectorBancorReserve: "12984682836133723970678",
      connectorOriginalReserve: "874893386551012559545885",
      smartTokenInETH: null,
      smartTokeninUSD: null,
      tokenDecimals: 18,
      conversionFee: "0.1",
      converterVersion: "10"
    }
  ]
    .map(relay => ({
      ...relay,
      symbol: relay.symbol.includes("(")
        ? relay.symbol.split("(")[0]
        : relay.symbol
    }))
    .map(relay => ({
      id: relay.smartTokenAddress,
      reserves: [
        {
          symbol: relay.symbol,
          decimals: relay.tokenDecimals,
          network: "ETH",
          contract: relay.tokenAddress
        },
        {
          symbol: relay.connectorType,
          decimals: 18,
          contract:
            relay.connectorType == "BNT"
              ? `0x1f573d6fb3f13d689ff844b4ce37794d79a7ff1c`
              : "0x309627af60f0926daa6041b8279484312f2bf060",
          network: "ETH"
        }
      ],
      contract: relay.converterAddress,
      smartToken: {
        decimals: 18,
        contract: relay.smartTokenAddress,
        network: "ETH",
        symbol: relay.smartTokenSymbol
      },
      fee: Number(relay.conversionFee),
      network: "ETH",
      isMultiContract: false,
      version: relay.converterVersion,
      owner: relay.owner
    }));
  return relays;
};

export type EosAccount = string;
export type EthereumAddress = string;
export type ContractAccount = EosAccount | EthereumAddress;

export interface Token {
  symbol: string;
  contract: string;
  decimals: number;
  network: string;
}

export interface Relay {
  id: string;
  reserves: Token[];
  smartToken: Token;
  contract: ContractAccount;
  isMultiContract: boolean;
  fee: number;
  network: string;
  version: string;
  owner: string;
}

const isAuthenticatedViaModule = (module: EosTransitModule) => {
  const isAuthenticated =
    module.wallet && module.wallet.auth && module.wallet.auth.accountName;
  if (!isAuthenticated) throw new Error("Not logged in");
  return isAuthenticated;
};

export const getBankBalance = async (): Promise<
  {
    id: number;
    quantity: string;
    symbl: string;
  }[]
> => {
  const account = isAuthenticatedViaModule(vxm.eosWallet);
  const res: {
    rows: {
      id: number;
      quantity: string;
      symbl: string;
    }[];
  } = await rpc.get_table_rows({
    code: process.env.VUE_APP_MULTICONTRACT!,
    scope: account,
    table: "accounts"
  })!;
  return res.rows;
};

export enum Feature {
  Trade,
  Wallet,
  Liquidity,
  CreatePool
}

export interface Service {
  namespace: string;
  features: Feature[];
}

export const services: Service[] = [
  {
    namespace: "eos",
    features: [
      Feature.Trade,
      Feature.Liquidity,
      Feature.Wallet,
      Feature.CreatePool
    ]
  },
  {
    namespace: "eth",
    features: [Feature.Trade, Feature.Liquidity, Feature.CreatePool]
  },
  { namespace: "usds", features: [Feature.Trade] }
];

export interface ReserveTableRow {
  contract: string;
  ratio: number;
  balance: string;
}

export interface SettingTableRow {
  currency: string;
  owner: string;
  stake_enabled: boolean;
  fee: number;
}

export interface ConverterV2Row {
  currency: string;
  fee: number;
  metadata_json: string[];
  owner: string;
  protocol_features: string[];
  reserve_balances: {
    key: string;
    value: {
      quantity: string;
      contract: string;
    };
  }[];
  reserve_weights: {
    key: string;
    value: number;
  }[];
}

interface BaseSymbol {
  symbol: string;
  precision: number;
}

const symToBaseSymbol = (symbol: Sym): BaseSymbol => ({
  symbol: symbol.code().to_string(),
  precision: symbol.precision()
});

const assetStringtoBaseSymbol = (assetString: string): BaseSymbol => {
  const asset = new Asset(assetString);
  return symToBaseSymbol(asset.symbol);
};

export const buildTokenId = ({ contract, symbol }: BaseToken): string =>
  contract + "-" + symbol;

export const fetchMultiRelays = async (): Promise<EosMultiRelay[]> => {
  const contractName = process.env.VUE_APP_MULTICONTRACT!;

  const rawRelays: {
    rows: ConverterV2Row[];
    more: boolean;
  } = await rpc.get_table_rows({
    code: process.env.VUE_APP_MULTICONTRACT,
    table: "converter.v2",
    scope: process.env.VUE_APP_MULTICONTRACT,
    limit: 99
  });
  if (rawRelays.more) {
    console.warn("Warning, there are more than 99 multi relays!");
  }
  const parsedRelays = rawRelays.rows;
  const passedRelays = parsedRelays
    .filter(
      relay =>
        relay.reserve_weights.reduce(
          (acc, reserve) => reserve.value + acc,
          0
        ) == 1000000
    )
    .filter(relay => relay.reserve_balances.length == 2);

  const smartTokenContract = process.env.VUE_APP_SMARTTOKENCONTRACT!;

  const relays: EosMultiRelay[] = passedRelays.map(relay => ({
    id: buildTokenId({
      contract: smartTokenContract,
      symbol: symToBaseSymbol(new Sym(relay.currency)).symbol
    }),
    reserves: relay.reserve_balances.map(({ value }) => ({
      ...assetStringtoBaseSymbol(value.quantity),
      id: buildTokenId({
        contract: value.contract,
        symbol: assetStringtoBaseSymbol(value.quantity).symbol
      }),
      contract: value.contract,
      network: "eos",
      amount: asset_to_number(new Asset(value.quantity))
    })),
    contract: contractName,
    owner: relay.owner,
    isMultiContract: true,
    smartToken: {
      ...symToBaseSymbol(new Sym(relay.currency)),
      id: buildTokenId({
        contract: smartTokenContract,
        symbol: symToBaseSymbol(new Sym(relay.currency)).symbol
      }),
      contract: smartTokenContract!,
      amount: 0,
      network: "eos"
    },
    fee: relay.fee / 1000000
  }));

  return relays;
};

export const fetchMultiRelay = async (
  smartTokenSymbol: string
): Promise<EosMultiRelay> => {
  const relays = await fetchMultiRelays();
  const relay = findOrThrow(
    relays,
    relay => compareString(relay.smartToken.symbol, smartTokenSymbol),
    `failed to find multi relay with smart token symbol of ${smartTokenSymbol}`
  );
  return {
    ...relay,
    reserves: sortByNetworkTokens(relay.reserves, reserve => reserve.symbol, [
      "BNT"
    ])
  };
};

const tokenMetaDataEndpoint =
  "https://raw.githubusercontent.com/eoscafe/eos-airdrops/master/tokens.json";

const hardCoded: () => TokenMeta[] = () =>
  [
    {
      name: "EOS",
      logo:
        "https://storage.googleapis.com/bancor-prod-file-store/images/communities/359b8290-0767-11e8-8744-97748b632eaf.png",
      logo_lg:
        "https://storage.googleapis.com/bancor-prod-file-store/images/communities/359b8290-0767-11e8-8744-97748b632eaf.png",
      symbol: "EOS",
      account: "eosio.token",
      chain: "eos"
    },
    {
      name: "Prochain",
      logo:
        "https://storage.googleapis.com/bancor-prod-file-store/images/communities/EPRA.png",
      logo_lg:
        "https://storage.googleapis.com/bancor-prod-file-store/images/communities/EPRA.png",
      symbol: "EPRA",
      account: "epraofficial",
      chain: "eos"
    },
    {
      name: "Gold Tael",
      logo:
        "https://storage.googleapis.com/bancor-prod-file-store/images/communities/f146c8c0-1e6c-11e9-96e6-590b33725e90.jpeg",
      logo_lg:
        "https://storage.googleapis.com/bancor-prod-file-store/images/communities/f146c8c0-1e6c-11e9-96e6-590b33725e90.jpeg",
      symbol: "TAEL",
      account: "realgoldtael",
      chain: "eos"
    },
    {
      name: "ZOS",
      logo:
        "https://storage.googleapis.com/bancor-prod-file-store/images/communities/636a3e10-328f-11e9-99c6-21750f32c67e.jpeg",
      logo_lg:
        "https://storage.googleapis.com/bancor-prod-file-store/images/communities/636a3e10-328f-11e9-99c6-21750f32c67e.jpeg",
      symbol: "ZOS",
      account: "zosdiscounts",
      chain: "eos"
    },
    {
      name: "EQUA",
      logo:
        "https://storage.googleapis.com/bancor-prod-file-store/images/communities/d03d3120-cd5b-11e9-923a-f50a5610b222.jpeg",
      logo_lg:
        "https://storage.googleapis.com/bancor-prod-file-store/images/communities/d03d3120-cd5b-11e9-923a-f50a5610b222.jpeg",
      symbol: "EQUA",
      account: "equacasheos1",
      chain: "eos"
    },
    {
      name: "FINX",
      logo:
        "https://storage.googleapis.com/bancor-prod-file-store/images/communities/77c385a0-6675-11e9-9f0e-7591708e99af.jpeg",
      logo_lg:
        "https://storage.googleapis.com/bancor-prod-file-store/images/communities/77c385a0-6675-11e9-9f0e-7591708e99af.jpeg",
      symbol: "FINX",
      account: "finxtokenvci",
      chain: "eos"
    }
  ].map(token => ({
    ...token,
    id: buildTokenId({ contract: token.account, symbol: token.symbol })
  }));

export const getTokenMeta = async (): Promise<TokenMeta[]> => {
  const res: AxiosResponse<TokenMeta[]> = await axios.get(
    tokenMetaDataEndpoint
  );
  return [...res.data, ...hardCoded()]
    .filter(token => compareString(token.chain, "eos"))
    .map(token => ({
      ...token,
      id: buildTokenId({ contract: token.account, symbol: token.symbol })
    }));
};

export interface TickerPrice {
  "15m": number;
  last: number;
  buy: number;
  sell: number;
  symbol: string;
}
