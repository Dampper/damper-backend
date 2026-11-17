export interface Network {
  rpc: string;
  passphrase: string;
  horizon: string;
}

export const MAINNET: Network = {
  rpc: process.env.DAMPER_RPC_URL ?? 'https://mainnet.sorobanrpc.com',
  passphrase: 'Public Global Stellar Network ; September 2015',
  horizon: process.env.DAMPER_HORIZON_URL ?? 'https://horizon.stellar.org',
};

/**
 * Blend V2 and V2.1 deployments. V2.1 runs the same pool contracts with its own
 * backstop and pool factory. Source: blend-capital/docs-v2 mainnet-deployments.md
 */
export const BLEND_DEPLOYMENTS = [
  {
    name: 'v2',
    backstop: 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7',
    poolFactory: 'CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU',
  },
  {
    name: 'v2.1',
    backstop: 'CCS4AZ5ORM6VLLPJTJUFRNXWBMHOO3L5WHHRPL2ZMILE35ZDMQFHOQMJ',
    poolFactory: 'CACUXRNBUFV7BFPKUDLVJFQI6H7EHHNSJPOFJSCWJCYUUYMORM6C63AL',
  },
] as const;

/** USDC (Circle) on Stellar, used as the quote asset when reading SDEX markets. */
export const USDC_CLASSIC = {
  code: 'USDC',
  issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
};
